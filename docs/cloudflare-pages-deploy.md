# Deploy Mission Control UI to Cloudflare Pages

The Mission Control dashboard is a single static file
(`src/dashboard/static/index.html`), so publishing it is a plain static deploy.
The workflow `.github/workflows/mission-control-pages.yml` does this on every
push to `main` that touches the dashboard, or manually via `workflow_dispatch`.

## One-time setup

1. Create a Cloudflare Pages project named `folderforge-mission-control`
   (or change `--project-name` in the workflow).
2. Add repo secrets:
   - `CLOUDFLARE_API_TOKEN` — a token with **Pages:Edit** on the account.
   - `CLOUDFLARE_ACCOUNT_ID` — the account ID from the Cloudflare dashboard.
3. Push to `main` or run the workflow manually.

## Connecting the hosted UI back to your machine

The hosted page is only the control plane *frontend*. It talks to the local
dashboard API, so the machine must be reachable:

1. Start the local dashboard (`folderforge chatgpt start` or the default
   `serve` flow, default port 7332). Bind it with a token.
2. Expose it with a quick tunnel from the UI (Tunnels panel) or
   `cloudflared tunnel --url http://127.0.0.1:7332`.
3. Open the hosted Pages URL against the tunnel origin (reverse proxy or
   `?token=` deep link) and save the bearer token in the header field — it is
   persisted per browser via localStorage.

## Hardening recommendations

- Put the Pages site behind **Cloudflare Access** so only your identity can
  load the control plane at all.
- Prefer a named tunnel + Access policy over quick tunnels for anything you
  keep running longer than a session (quick-tunnel URLs are unguessable but
  unlisted-public).
- Never expose the dashboard without a token when bound to a non-loopback
  host — the server enforces this, keep it that way.
