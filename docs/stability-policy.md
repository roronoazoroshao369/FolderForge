# Stability and regression policy

FolderForge is in a stabilization freeze after the 3.0.0 candidate. The goal is to reduce defects and user friction, not expand the tool surface.

## Freeze scope

Net-new product surface is frozen until the maintainer explicitly ends the milestone. Allowed changes are:

- security and containment fixes;
- reproducible bug fixes and UX corrections;
- compatibility, accessibility, reliability, observability, and documentation work;
- beta instrumentation and release evidence;
- tests, refactors, or dependency updates required to close one of the above.

A feature exception must name the user harm it prevents, the rollback, and the council/reviewer decision. “Useful later” is not an exception.

## Definition of done for a defect

A bug is not closed until the change includes:

1. a minimal reproduction or evidence showing the failure;
2. a regression test that fails before the fix and passes after it, at the lowest practical layer;
3. root-cause and affected-version notes;
4. security/compatibility analysis, including data-loss or release-blocker status;
5. user-facing docs or migration/rollback notes when behavior changes;
6. the relevant focused tests plus typecheck, lint, test, build, and docs gates.

If a deterministic automated regression test is technically impossible, the PR must explain why, include a reproducible manual proof, and obtain maintainer approval. “Too hard to test” is not sufficient.

## Severity and response

| Severity | Example | Release posture |
| --- | --- | --- |
| Critical | authorization bypass, secret exposure, data loss | stop release; private security process when applicable |
| High | destructive wrong action, broken install/upgrade, audit unavailable | stop release until fixed with regression coverage |
| Medium | core workflow failure with workaround | fix in stabilization milestone |
| Low | localized UX/docs defect | prioritize by frequency and user cost |

Every release-blocking beta issue must set `regressionTestAdded: true` in reviewed beta evidence before graduation.

## Pull-request gate

Every PR must classify itself as bug, security, UX, compatibility, docs, observability, test, or approved exception. Reviewers reject unrelated feature expansion, missing regression proof, weakened hard boundaries, or claims that exceed available external evidence.

## Honest evidence

Local tests, CI, soak, council review, external beta, and publication are separate facts. A green local suite does not prove external usability; generated records do not count as beta participants; automated council analysis does not count as independent human ratification.
