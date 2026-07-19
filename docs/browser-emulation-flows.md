# Browser emulation and composed UI flows

FolderForge 2.5 extends the Playwright child integration with device/context
profiles, loopback network shaping, and bounded multi-step UI flows.

## Device and network profiles

`browser_emulate` supports:

- `desktop` — 1440×900;
- `mobile` — Playwright `iPhone 15` device;
- `tablet` — Playwright `iPad (gen 7)` device;
- `slow3g` — 400 ms latency and bounded upload/download throughput;
- `fast3g` — 150 ms latency and higher bounded throughput;
- `offline` — all proxied HTTP and HTTPS CONNECT requests rejected;
- `reset` — restore the original Playwright adapter definition.

Custom device, viewport, user-agent, and network fields are also accepted within
schema bounds. Device and explicit viewport are mutually exclusive.

The manager restarts only the Playwright child adapter with managed CLI flags; it
preserves unrelated baseline arguments such as `--isolated`. Network shaping uses
a loopback-only proxy and never performs TLS interception. HTTPS traffic is
shaped as a CONNECT tunnel. The proxy strips hop-by-hop/proxy credentials before
forwarding HTTP requests and exposes counters through
`browser_emulation_status`.

Network throughput is an application-level approximation, not kernel traffic
control. Use a container/network namespace or dedicated test infrastructure when
you need packet-level loss, jitter, DNS faults, or exact mobile-radio behavior.

## Composed flows

`browser_flow_run` accepts 1–50 ordered steps. Allowed actions are fixed:

- open, viewport, snapshot, click, type;
- console and network inspection;
- screenshot, visual comparison, accessibility audit;
- close;
- a bounded 0–30 second wait.

`browser_eval` and arbitrary JavaScript are deliberately excluded. Each browser
action re-enters the normal agent registry, so it keeps its own policy,
rate-limit, approval, cancellation, and audit event. The flow returns bounded
per-step evidence; image blocks are represented by MIME type and byte count
rather than duplicating base64.

By default the flow stops at the first failed step. `continueOnError` is explicit
per step. Cancellation stops the flow and preserves completed evidence.

Example:

```json
{
  "steps": [
    { "name": "open", "action": "browser_open", "args": { "url": "http://127.0.0.1:3000" } },
    { "action": "browser_set_viewport", "args": { "width": 390, "height": 844 } },
    { "action": "browser_snapshot" },
    { "action": "browser_accessibility_audit" },
    { "action": "browser_screenshot", "args": { "fullPage": true } }
  ]
}
```
