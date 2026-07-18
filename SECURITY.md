# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory reporting for this repository when available. Otherwise contact
the repository owner privately through the contact method on their GitHub profile.

Include the affected version or commit, reproduction steps, impact, required
configuration, and any suggested mitigation. Do not include real credentials or
third-party data.

## Response expectations

A maintainer will acknowledge a complete report when it is reviewed, coordinate
validation and remediation, and credit the reporter when appropriate. Timelines
depend on severity and reproducibility; no fixed disclosure deadline is promised.
Please allow a reasonable remediation period before public disclosure.

## Supported versions

Security fixes target the current npm `latest` release and the current `main`
branch. Older releases may be asked to upgrade.

## Scope and secure use

FolderForge executes local development operations and optional child MCP/plugin
packages. Only enable packages and commands you trust. Keep HTTP on loopback unless
explicit authentication and deployment controls are configured. The detailed
threat model and controls are documented in [docs/security.md](docs/security.md).
