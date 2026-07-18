# Contributing to FolderForge

Thank you for improving FolderForge.

## Development setup

Use Node.js 22 or 24.

```bash
git clone https://github.com/roronoazoroshao369/FolderForge.git
cd FolderForge
npm ci --ignore-scripts
npm run build
npm test
```

Browser installation is optional and explicit; normal dependency installation
must not download Chromium.

## Before opening a pull request

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke:package
npm run smoke:stdio
npm run smoke:http
npm run docs:check
npm pack --dry-run
```

Keep source, generated `dist`, tests, documentation, package contents, and
changelog claims synchronized. Do not weaken path policy, authentication,
approval separation, redaction, or secure defaults to make a test pass.

## Pull requests

Explain the user problem, security impact, platforms exercised, and exact
validation commands. Add regression coverage for behavior changes. A local Linux
pass is not evidence for Windows or macOS; CI provides platform acceptance for
the exact revision.

Do not include credentials, runtime state, audit logs, generated browser data,
`node_modules`, or unrelated formatting churn.

## Releases

Only maintainers perform version changes, tags, npm publication, and hosted
releases. Follow [docs/releasing.md](docs/releasing.md). Publishing, tagging, and
history rewrites require explicit authorization.

## Security

Report vulnerabilities using [SECURITY.md](SECURITY.md), not a public issue.
