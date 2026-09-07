---
title: Files
navTitle: Files
section: Work
order: 150
description: Personal and group storage with browsing, search, previews, uploads, and file operations.
tags: [files, storage, search, capabilities]
updated: 2026-09-07
---

# Files

Files gives IPA users one place to work with their personal storage and the
storage shared through their group memberships. Browse folders, search across
accessible bases, preview supported files, and manage items without leaving
Cloud.

## Use Files

- Open your home base or a group base from the same overview.
- Browse folders or filter the current directory by name.
- Search selected bases with glob patterns such as `**/*.pdf`.
- Upload files or folders, create directories, and inspect item details.
- Download, rename, duplicate, move, copy, or send items to Trash.

Group storage is shared. A move or delete there affects other users who work in
the same base.

## Understand the Files model

| Resource or surface | Responsibility |
| --- | --- |
| File base | One accessible storage root: the current user's home or an IPA group's shared directory |
| Folder path | The current location inside a base, preserved in breadcrumbs and URLs |
| File or directory | An item with its name, path, type, size, modified time, and optional media metadata |
| Search | Folder filtering or a glob search across selected accessible bases |
| Upload session | A bounded chunked transfer with progress and per-chunk retries before the final file is assembled |
| Trash | The recovery destination used by delete actions in the file browser |

Home access comes from the current IPA account. Group bases come from recursive
IPA group membership. Files resolves those bases before it performs an
operation; a path alone does not grant access.

## How Files fits Cloud

Files owns navigation, search, previews, transfer workflows, and its application
API. Filegate performs storage operations against the configured home and group
roots. Cloud supplies IPA identity, settings, application discovery, OpenAPI,
universal search capabilities, and the shared Help surface.

## Find detailed product help

Open **Help** inside Files for browsing, upload, previews, move and delete
behavior, display settings, and troubleshooting. Developers can read
[App capabilities](/en/docs/platform/capabilities),
[Application settings](/en/docs/platform/settings), and
[Resource authorization](/en/docs/identity/authorization) for the shared
contracts Files adopts.

## Automate Files from the terminal

Files does not register a dedicated `cld files` module. Its read-only search is
available through the generic capabilities interface:

```bash
cld capabilities query files search \
  --input '{"query":"report","tags":["pdf"],"limit":10}' \
  --json
```

Run `cld capabilities catalog --json` to inspect the live schema and safety
metadata. Run `cld capabilities query --help` for the current invocation
syntax. Capability queries use the current profile and return only accessible
bases and items.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
