# Web quality benchmark fixture

Serve this directory on localhost with any static HTTP server. The initial page
intentionally omits document language/title, image alt text, accessible names,
proper heading order, adequate contrast, and a responsive width. A benchmark run
must capture its own baseline artifact before the candidate edits begin, then
verify the repaired page at mobile and desktop viewports with
`browser_visual_compare` and `browser_accessibility_audit`.
