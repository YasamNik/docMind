# Tunnel rules (mandatory)

The user tests remotely through a Cloudflare quick tunnel. The tunnel must never break.

## Before any branch switch, merge, or checkout

1. Check if `apps/client/vite.config.ts` has `host: true` and `allowedHosts: true`.
2. If those lines are uncommitted local changes, commit them FIRST, before switching.
3. After switching, verify the file still has the tunnel fix. If not, re-apply and commit.

## Before any git stash, reset, or restore that touches client files

Verify the tunnel fix will survive. If it would be lost, commit it first.

## After starting or restarting the dev server

Verify the tunnel responds: `curl -s -o /dev/null -w "%{http_code}" <tunnel-url>`
must return 200. If it returns 403, restart the Vite dev server.

## When creating a new feature branch

The tunnel config (`host: true`, `allowedHosts: true` in vite.config.ts, and the
`*.trycloudflare.com` wildcard in auth.services.ts) must be present on every branch.
These are committed to `feat/milestone-c3` and will be on `main` after the merge.
If starting a branch from a point before these commits, cherry-pick or re-apply them.

## Never

- Point the tunnel at port 4000 (API only). Always use 5173 (Vite with proxy).
- Start multiple cloudflared processes. Kill old ones first.
- Use `allowedHosts: "all"` (string). Only `allowedHosts: true` (boolean) works on Vite 8.x.
- Leave the tunnel fix as an uncommitted change. Always commit it.
