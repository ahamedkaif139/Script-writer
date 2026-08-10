# Script Roll — Cloudflare Secure Edition

This project keeps the original Script Roll visual style and moves Gemini access to a Cloudflare Worker. It adds:

- Sign up / login / logout
- PBKDF2 password hashing in the Worker
- HttpOnly Secure SameSite session cookies
- Cloudflare D1 users, sessions, scripts, and daily usage
- Save/open/delete scripts
- Gemini API key stored as a Worker Secret
- 20 AI generations per user per UTC day in the application layer
- Static frontend served from Workers Static Assets

## Files

- `public/index.html` — frontend
- `src/index.js` — Worker API + authentication + Gemini proxy
- `migrations/0001_initial.sql` — D1 schema
- `wrangler.jsonc` — Worker, assets, D1, secret configuration

## Local test

1. Install Node.js 18+ and run `npm install -D wrangler`.
2. Copy `.dev.vars.example` to `.dev.vars` and put your Gemini API key there.
3. Change `database_id` in `wrangler.jsonc` only for remote deployment; local D1 does not need the remote ID to simulate the DB if you use the local migration command.
4. Run:

```bash
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

Open the local URL printed by Wrangler.

## Cloudflare deployment

Create a D1 database named `script_writer_db`, copy its ID into `wrangler.jsonc`, apply the migration remotely, and set the Gemini secret:

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

When prompted for `GEMINI_API_KEY`, paste the key. Do not put it in `public/index.html`.

## Security notes

This is a solid starter, not a full enterprise identity system. For a larger public service, add email verification, password reset/recovery, stronger abuse/rate limiting, account deletion/export, monitoring, and a formal privacy policy.

Gemini model: `gemini-3.6-flash`. The frontend never receives the Gemini key.
