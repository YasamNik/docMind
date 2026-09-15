---
paths:
  - "apps/client/**"
---

# Client rules

Loaded when working under `apps/client/`. Complements `CLAUDE.md`.

- React with Vite and Tailwind. Pages under `src/pages/<area>/`, shared components under
  `src/components/`, API client and helpers under `src/lib/`.
- Server state through TanStack Query. Local UI state in component state. No global
  store until a real need appears.
- The API client is the only place that knows URLs. Components call typed functions.
- Settings forms are generated from the settings registry the server exposes. Do not
  hand-write a form per provider or driver. Each form renders its setup guide beside it:
  numbered steps, links to the exact page, copyable values such as the redirect URI.
- Secrets in forms: show "set, ends in 1234" and a Replace action. Never prefill a secret.
- Every destructive or costly action (clear credentials, change embedding model, delete
  document) confirms first and states the consequence in plain words.
- Copy is plain and specific. No em dashes. Error text from providers is shown verbatim
  under a short explanation.
