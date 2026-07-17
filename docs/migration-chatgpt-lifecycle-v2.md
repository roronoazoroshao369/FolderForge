# Migration: ChatGPT lifecycle receipt v2

This migration applies to projects created by earlier versions of
`folderforge connect chatgpt` that have a version 1 receipt or broad Auth0 user
subject policy.

## Summary

The lifecycle now manages the ChatGPT DCR client after the user clicks Connect.
It safely detects the new client, enables the intended login connection, creates
a per-client user grant, verifies `/authorize`, and exposes the same state in the
CLI and dashboard.

Receipt version 1 is accepted. FolderForge upgrades it in memory and writes
version 2 on the next status, repair, start, or connect operation.

## Behavior changes

| Earlier behavior                                                  | Version 2 behavior                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Setup stopped after public OAuth metadata and the `401` challenge | Setup waits for the ChatGPT DCR client and repairs the remaining Auth0 lifecycle                |
| Quick mode could use broad user access                            | Quick mode uses `user.require_client_grant` and a per-client `subject_type=user` grant          |
| Client-credentials subject could be grant-enabled                 | Machine/client subject policy is `deny_all` for the interactive ChatGPT flow                    |
| User might need to copy a `tpc_*` ID                              | Happy path detects the new client automatically                                                 |
| Login connection was an external manual task                      | FolderForge enables selected connections only for the verified client                           |
| Status was process/metadata oriented                              | Status and dashboard expose the full shared lifecycle and diagnostics                           |
| A quick-tunnel restart could encourage client reuse               | A changed resource URL requires a new DCR client; the old client is not silently granted access |

## Upgrade procedure

From the project root:

```bash
folderforge chatgpt status
folderforge chatgpt repair
```

When FolderForge reaches `WAITING_FOR_CHATGPT_CLIENT`, open ChatGPT and click
Connect for the connector. To explicitly resume polling:

```bash
folderforge connect chatgpt --wait
```

When the command reports `READY_TO_COMPLETE_LOGIN`, return to ChatGPT and finish
Auth0 login or consent.

## Existing Auth0 resource servers

FolderForge matches the exact resource identifier before making changes. It may
repair:

- RS256 signing;
- RFC 9068 token dialect;
- token lifetime;
- offline access;
- missing FolderForge scopes;
- subject policy to `user.require_client_grant` and `client.deny_all`.

Unrelated scopes and descriptions are preserved. Remote APIs, clients,
connections, and grants are never deleted automatically.

Review any deployment that intentionally relied on broad third-party-client
access. After migration, each ChatGPT public client needs its own user grant.

## Existing ChatGPT clients

A client stored in the version 2 receipt can be revalidated and repaired when:

- its callbacks remain under `https://chatgpt.com/connector/oauth/`;
- Auth0 still marks it as a DCR public authorization-code client;
- Auth0 logs prove it requested the exact current FolderForge resource.

For a reviewed existing client that is not yet in the receipt:

```bash
folderforge chatgpt repair --client-id <public-client-id>
```

The client ID is public metadata. Do not provide a client secret.

When a Cloudflare quick tunnel changes hostname, do not reuse the old client for
the new resource. Recreate or reconnect the ChatGPT connector so a new client
requests the new audience.

## Login connection selection

A single active Auth0 database connection is selected automatically. When the
tenant has multiple plausible connections, specify the intended one:

```bash
folderforge chatgpt repair \
  --login-connection Username-Password-Authentication
```

The selection is persisted in the runtime receipt. FolderForge adds only the
verified ChatGPT client to the connection membership.

## Receipt changes

Version 2 adds:

- granular checks for DCR, local server, public endpoint, client, connection,
  user grant, and authorize readiness;
- a lifecycle session ID and start time;
- detected-client callback/resource evidence;
- selected connection IDs and names;
- user-grant ID/audience/scopes/subject type;
- authorize probe outcome;
- diagnostics, timeline state, and dashboard snapshot.

It does not add tokens, secrets, authorization codes, PKCE verifiers, or browser
session data. Secret-shaped fields and complete JWTs are rejected.

## Rollback considerations

The version 2 receipt is not understood by older FolderForge versions. Keep a
copy of the project before downgrading. A downgrade must not restore broad Auth0
access merely to make an older command succeed.

Local disconnect remains non-destructive:

```bash
folderforge chatgpt disconnect
```

It stops managed processes and preserves remote Auth0 resources for review.
