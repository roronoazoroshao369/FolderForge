# FolderForge beta program

The beta program is prepared but is not opened automatically by a code change.
Public enrollment, announcements, invitations, and collection of third-party data
require an explicit maintainer decision after the exact candidate passes the
required CI matrix.

## Beta goals

The beta is intended to validate real usage rather than maximize sign-ups:

- installation and first MCP connection on Ubuntu, macOS, and Windows;
- compatibility with at least three independent MCP clients;
- recovery from child MCP failures and approval interruptions;
- plugin manifest authoring, sandbox setup, and diagnostics;
- artifact, visual-regression, and accessibility workflows;
- documentation clarity and upgrade behavior;
- audit usefulness and false-positive/false-negative policy reports.

## Entry gate

A candidate can be announced only when:

1. the exact commit passes Ubuntu/macOS/Windows on Node 22 and 24;
2. coverage, property/fuzz, heartbeat stress, and MCP Inspector gates pass;
3. npm trusted publishing is configured for the exact GitHub workflow and
   protected environment;
4. release artifacts include build provenance and an SBOM attestation;
5. known security boundaries are documented without claiming unsupported host
   isolation;
6. benchmark methodology is frozen before comparative results are collected.

## Cohorts

Start with 10–20 invited participants across these roles:

- individual AI-assisted developers;
- maintainers of TypeScript, Python, and Godot projects;
- MCP/plugin authors;
- security-minded operators;
- Windows and macOS users, not only Linux maintainers.

No participant should be asked to provide production secrets or proprietary
source. Use disposable or approved test projects. Security findings follow
`SECURITY.md`, not public issue templates.

## Evidence collected

Collect version/commit, operating system, Node version, MCP client, configuration
shape, reproduction steps, expected/actual behavior, redacted doctor output, and
whether a safe workaround exists. Optional metrics include time-to-first-tool,
tool discovery count, approval interruptions, child recovery time, and artifact
size. Do not collect tokens, credentials, source files, audit logs, screenshots,
or personal data unless the participant deliberately attaches a reviewed and
redacted sample.

## Exit criteria

Beta can graduate only after:

- at least 30 completed installations across all three supported OS families;
- at least five external plugin packages complete validation and sandbox review;
- no unresolved critical/high vulnerability or data-loss report;
- at least 95% successful clean-install and upgrade attempts in the final cohort;
- every reproducible release-blocking failure has a regression test;
- support, migration, and rollback documentation has been exercised by someone
  other than the primary maintainer.

The issue templates `beta_feedback.yml` and `plugin_submission.yml` provide the
intake structure. Opening GitHub Discussions, publishing an announcement, or
inviting participants remains an operator-controlled public action.


## Evidence tooling

The repository includes a strict local intake/report tool. It does not upload or
open the beta automatically.

```bash
node scripts/beta-evidence.mjs ingest   --project /path/to/project   --file reviewed-evidence.json

node scripts/beta-evidence.mjs report --project /path/to/project
```

The input contract is `beta/schema/evidence.schema.json`; a non-sensitive example
is in `beta/examples/evidence.example.json`.

The intake tool:

- hashes participant-generated installation IDs and external package IDs;
- drops fields outside the bounded contract instead of storing attachments;
- redacts common bearer/token/secret/password/API-key/JWT forms in notes;
- writes mode-`0600` deduplicated records under `.folderforge/beta/evidence`;
- never accepts source archives, screenshots, audit logs, or credentials.

The report sets `graduated=true` only when every exit gate has evidence: at least
30 successful unique installations, Ubuntu/macOS/Windows coverage, at least three
independent clients, five validated+sandbox-reviewed external plugins, no open
high/critical/data-loss issue, at least 95% final-cohort success, regression tests
for every release blocker, and documentation exercised by an external person.
Code cannot manufacture these external facts; public recruitment and evidence
collection remain operator-controlled.
