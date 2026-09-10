# SPA visual regression suite (proposal 018)

Pixel-level visual regression tests for the Mission Control SPA
(`packages/mission-control`, 9 screens). The suite boots the real dashboard
harness (fixture data, no auth, ephemeral loopback port), serves the BUILT
SPA at `/app/`, drives headless Chromium via `playwright-core`, and compares
each screen against the committed baselines in `baselines/`.

## Running

```sh
npm run build                 # the suite reads the built SPA from dist/
npx vitest run tests/visual   # compare against baselines
```

The suite **skips itself** when no Chromium binary is available (CI hosts
without the ms-playwright cache stay green — a documented limitation, not a
failure).

## Regenerating baselines (intentionally, never as a reflex)

```sh
FF_VISUAL_UPDATE=1 npx vitest run tests/visual
```

Only regenerate after a deliberate UI change, and review the new PNGs in the
diff before committing. Baselines are **host-locked**: they are generated
and compared on the same machine/Chromium build, like the rest of the
browser-dependent suites.

## Thresholds (locked by QA — never bump to hide churn)

- Per-channel tolerance: 12 (absorbs anti-alias noise).
- Fail when more than 0.2% of pixels differ, or on any dimension mismatch.
- On failure the actual and heat-map PNGs land in `/tmp/ff-visual-*` and the
  assertion message names them.

## Stability mechanics

- Animations and transitions are disabled via injected CSS before every
  screenshot.
- Settle = `networkidle` + one 300ms beat past the first data paint.
- Any page request off `127.0.0.1` is aborted **and fails the test** — the
  SPA must stay fully self-contained.
- Any masked (excluded) region in a screenshot must carry a code comment
  with evidence of why it churns.
