const SESSION_DAYS = 30;
const DAILY_GENERATION_LIMIT = 20;
const GEMINI_MODEL = "gemini-3.6-flash";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...extraHeaders },
  });
}

function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function safeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return base64url(new Uint8Array(digest));
}

async function hashPassword(password, saltBytes = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: 120000, hash: "SHA-256" }, key, 256);
  return `${base64url(saltBytes)}.${base64url(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(".");
  if (!salt || !expected) return false;
  const actual = await hashPassword(password, fromBase64url(salt));
  const a = fromBase64url(actual.split(".")[1]);
  const b = fromBase64url(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function cookieHeader(token) {
  return `session=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
function clearCookieHeader() {
  return "session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}
function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const found = raw.split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

async function createSession(db, userId) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await db.prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)").bind(userId, tokenHash, expires).run();
  return token;
}

async function getUser(request, db) {
  const token = getCookie(request, "session");
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await db.prepare(`SELECT users.id, users.email, sessions.expires_at
    FROM sessions JOIN users ON users.id=sessions.user_id
    WHERE sessions.token_hash=? AND sessions.expires_at > CURRENT_TIMESTAMP`).bind(tokenHash).first();
  if (!row) return null;
  return { id: row.id, email: row.email, expires_at: row.expires_at, tokenHash };
}

function requireSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function generationUsage(db, userId) {
  const row = await db.prepare("SELECT count FROM usage_daily WHERE user_id=? AND day=?").bind(userId, today()).first();
  return Number(row?.count || 0);
}

async function generateScript(request, env, user) {
  if (!env.GEMINI_API_KEY) return json({ error: "Gemini API secret is not configured on this Worker." }, 500);
  const input = await body(request);
  const prompt = String(input.prompt || "").trim();
  if (!prompt) return json({ error: "Prompt is required." }, 400);
  if (prompt.length > 12000) return json({ error: "Prompt is too long." }, 413);

  const used = await generationUsage(env.DB, user.id);
  if (used >= DAILY_GENERATION_LIMIT) return json({ error: `Daily AI limit reached (${DAILY_GENERATION_LIMIT}). Try again tomorrow.`, used, limit: DAILY_GENERATION_LIMIT }, 429);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 4096 } }),
  });
  const data = await res.json();
  if (!res.ok) {
    const message = data?.error?.message || `Gemini request failed (${res.status})`;
    if (res.status === 429) return json({ error: "Gemini rate limit reached. Please wait and try again." }, 429);
    return json({ error: message }, 502);
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || "").join("").trim();
  if (!text) return json({ error: "Gemini returned no text." }, 502);

  await env.DB.prepare(`INSERT INTO usage_daily (user_id, day, count) VALUES (?, ?, 1)
    ON CONFLICT(user_id, day) DO UPDATE SET count=count+1`).bind(user.id, today()).run();
  const newUsed = await generationUsage(env.DB, user.id);
  return json({ text, used: newUsed, limit: DAILY_GENERATION_LIMIT });
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !requireSameOrigin(request)) return json({ error: "Invalid origin." }, 403);

  if (path === "/api/signup" && method === "POST") {
    const input = await body(request); const email = safeEmail(input.email); const password = String(input.password || "");
    if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
    if (password.length < 8 || password.length > 200) return json({ error: "Password must be 8–200 characters." }, 400);
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (exists) return json({ error: "An account with that email already exists." }, 409);
    const passwordHash = await hashPassword(password);
    const result = await env.DB.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").bind(email, passwordHash).run();
    const token = await createSession(env.DB, result.meta.last_row_id);
    return json({ user: { id: result.meta.last_row_id, email } }, 201, { "Set-Cookie": cookieHeader(token) });
  }

  if (path === "/api/login" && method === "POST") {
    const input = await body(request); const email = safeEmail(input.email); const password = String(input.password || "");
    const user = await env.DB.prepare("SELECT id,email,password_hash FROM users WHERE email=?").bind(email).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) return json({ error: "Incorrect email or password." }, 401);
    const token = await createSession(env.DB, user.id);
    return json({ user: { id: user.id, email: user.email } }, 200, { "Set-Cookie": cookieHeader(token) });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = getCookie(request, "session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader() });
  }

  const user = await getUser(request, env.DB);
  if (path === "/api/me" && method === "GET") {
    if (!user) return json({ error: "Not signed in." }, 401);
    return json({ user: { id: user.id, email: user.email }, usage: { used: await generationUsage(env.DB, user.id), limit: DAILY_GENERATION_LIMIT } });
  }
  if (!user) return json({ error: "Sign in required." }, 401);

  if (path === "/api/generate" && method === "POST") return generateScript(request, env, user);

  if (path === "/api/scripts" && method === "GET") {
    const rows = await env.DB.prepare(`SELECT id,title,content,created_at,updated_at FROM scripts WHERE user_id=? ORDER BY updated_at DESC`).bind(user.id).all();
    return json({ scripts: rows.results || [] });
  }

  if (path === "/api/scripts" && method === "POST") {
    const input = await body(request); const title = String(input.title || "Untitled script").trim().slice(0, 120); const content = String(input.content || "").trim();
    if (!content) return json({ error: "Script content is required." }, 400);
    if (content.length > 200000) return json({ error: "Script is too large." }, 413);
    const result = await env.DB.prepare("INSERT INTO scripts (user_id,title,content) VALUES (?,?,?)").bind(user.id, title || "Untitled script", content).run();
    return json({ id: result.meta.last_row_id }, 201);
  }

  const match = path.match(/^\/api\/scripts\/(\d+)$/);
  if (match && method === "DELETE") {
    const id = Number(match[1]);
    await env.DB.prepare("DELETE FROM scripts WHERE id=? AND user_id=?").bind(id, user.id).run();
    return json({ ok: true });
  }

  return json({ error: "API route not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
