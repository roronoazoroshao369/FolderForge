# Proposal 018: visual regression tests for the Mission Control SPA

- Author role: QA/Verifier
- Date: 2026-09-09
- Status: implemented (2026-09-09, merged to main)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

Debt #21/#24: the 9-screen Tailwind SPA (rebuilt in #17, hardened through
#18–#24) has zero visual regression coverage. Every quality loop so far
verified screenshots by hand; any restyle, token change, or layout edit can
silently break the UI — the #17 blank-page bug (missing trailing slash)
was only caught by manual QA. The council's own UI changes (#42 Fleet.tsx,
#21 cards, …) currently land with no automated visual gate.

## Proposal

Add a self-contained visual regression suite — **test-only change**, no
product code:

1. **`tests/visual/spa-visual.test.ts`** — boots the proven dashboard harness
   (`defaultConfig(root)` + `Container` + `buildRegistry` +
   `startDashboard({ host: '127.0.0.1', port: 0 })`, no auth) which serves
   the built SPA at `/app/`, and drives headless Chromium via
   `playwright-core` (already in node_modules; its registry resolves the
   cached chromium-1194 offline — verified on this host; fallback:
   `executablePath` to the newest cached `chromium-*`). The suite
   **self-skips when no Chromium binary exists** (documented posture, same
   as the existing browser tests — CI without the cache stays green).
2. **Per-route screenshots**: all 9 screens at 1280×900 / dSF 1, plus
   Overview and Fleet at 390×844 (the two responsive-audited screens from
   #17). Animations and transitions are disabled via injected CSS
   (`* { animation: none !important; transition: none !important; }`);
   settle = networkidle + one beat. Harness data is deterministic (static
   fixtures, empty fleet/approvals/audit); any masked volatile region must
   carry a code comment with evidence of why it churns.
3. **`tests/visual/lib/pixel-diff.ts`** — pngjs-based compare (pngjs already
   in node_modules): decode baseline + actual; a pixel counts when any
   channel differs by more than 12; the test fails on dimension mismatch or
   > 0.2% differing pixels. On failure the actual and diff PNGs are written
   to /tmp and named in the assertion message.
4. **Baselines** committed at `tests/visual/baselines/*.png`, regenerated
   with `FF_VISUAL_UPDATE=1` (documented in `tests/visual/README.md`).
5. **devDependencies**: pin `pngjs` and `playwright-core` explicitly (both
   already installed as transitives of the existing browser stack — a
   manifest/lockfile entry only, no new download) so a future hoisting
   change cannot silently break the suite.

Non-goals: no new npm packages beyond the two pins; no CI workflow changes
(skip-gate keeps CI green without the browser cache — pre-building a
browser in CI is a separate decision); no cross-browser matrix (Chromium
only); no product/UI changes.

## Threat surface (Security hat)

Test-only: no product code, tool surface, schema, policy, or permission
changes. Chromium runs headless against a 127.0.0.1 ephemeral port serving
static fixture data; the SPA has no external references (bundled lucide
icons, system font stack) so no network egress occurs. Baseline PNGs
contain only fixture data (empty fleet/approvals, synthetic audit rows) —
no real tokens, hostnames, or paths. The pinned devDependencies are already
present in node_modules at the pinned versions.

## Test plan (QA hat)

- The suite is the test plan: 11 screenshot assertions (9 desktop + 2
  mobile) + dimension-mismatch handling + update mode.
- **Determinism proof (mandatory)**: generate baselines
  (`FF_VISUAL_UPDATE=1`), then run the suite twice normally — both runs
  must pass; a third run after a fresh `npm run build` must also pass. Any
  churn beyond the 0.2% threshold forces a documented mask or a fix —
  never a threshold bump to hide it.
- Gates: targeted (the visual file), typecheck/lint/build 0/0/0, full suite
  (run_test async, disclosed per #27) with the visual suite active on this
  host.
- Live proof: the suite's own run against the built dist SPA with per-screen
  diff ratios printed as evidence.

## Rollback

Revert the branch commit; the repo loses the visual suite (baselines,
helper, devDep pins). No product or data risk either way.

## Decision log

- 2026-09-09 — QA/Verifier — propose — loop #47, candidate #1 from the
  post-#46 queue (debt #21/#24). Research evidence: SPA = React 18 + Vite +
  Tailwind 4, 9 routes (App.tsx), useApi polls 5s + animate-* classes
  (flakiness sources, handled by CSS disable + settle); api.ts token via
  ?token=/localStorage (harness needs none — no auth); dashboard harness
  pattern proven in dashboard-fleet.test.ts; playwright-core
  1.56.0-alpha-2025-10-01 wants chromium-1194 and ~/.cache/ms-playwright
  HAS chromium-1194 (offline resolution works); pngjs present in
  node_modules; vitest default include covers tests/visual.
- 2026-09-09 — Security Officer — **approve with amendments** — (1) the
  suite must never reach the network: assert at runtime that every request
  the page makes stays on 127.0.0.1 (route-abort anything else, and fail if
  one fires); (2) no secrets in baselines — fixtures only, verified by the
  harness having no auth/token; (3) the two devDep pins must match the
  installed transitive versions exactly (no silent upgrade); (4) Chromium
  launches headless with --no-sandbox avoided unless required (prefer
  default sandbox flags; document if the host needs otherwise). This
  approval does NOT cover merge/push — Git needs separate user approval.
- 2026-09-09 — QA/Verifier — **approve with amendments** — (1) determinism
  proof = baseline generation + two green normal runs + one green run after
  a fresh build, all in this loop; (2) any masked region needs a comment
  with churn evidence; (3) threshold constants (12 per-channel, 0.2%
  pixels) documented in pixel-diff.ts; (4) skip-on-missing-chromium is
  mandatory (CI without the cache must not fail); (5) full-suite evidence
  method disclosed per #27; (6) per-screen diff ratios printed in the
  live-proof run.
- 2026-09-09 — QA/Verifier — **gates green on the final code** — visual
  suite 11/11 PASS (9 desktop 1280×900 + 2 mobile 390×844), determinism
  proof complete: baseline generation (FF_VISUAL_UPDATE=1) → normal run ×2
  → fresh `npm run build` → run again — ALL green, stable ratios (≤0.028%
  vs the 0.2% ceiling; most screens exactly 0). One mid-loop harness
  failure, diagnosed with evidence (debug probe): tests/setup.ts sandboxes
  $HOME → playwright-core's default cache path pointed into the void → the
  suite skipped; fixed by pinning PLAYWRIGHT_BROWSERS_PATH to the real user
  cache via os.userInfo() and scanning both chrome-linux and chrome-linux64
  layouts plus chromium_headless_shell-* dirs. lint exit 0, typecheck exit
  0, build exit 0, full suite **136 files / 1126 tests PASS** (91.33s,
  run_test async — disclosed per #27; 136 = 135 + the visual file; 1126 =
  1115 + the 11 new tests; the visual suite passes inside the full suite).
  Live proof = the suite's own runs against the built dist SPA with
  per-screen diff ratios printed (the proposal's definition).
- 2026-09-09 — User — **Git approved** — commit + merge --no-ff to main +
  push origin for loop #47 (survey approval after the LOOP REPORT).
