# Filesv2 CLI

Filesv2 combines accessible Cloud and FreeIPA homes and group directories.
Use `cld filesv2`; the older Files application is separate. Check
`cld apps list --json` and `cld filesv2 help` before using the commands.

## Browse and download

```bash
cld filesv2 bases list --json
cld filesv2 list <base-id> --json
cld filesv2 list <base-id> --path Documents --json
cld filesv2 list <base-id> --path Documents --after '<next>' --json
cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf --json
```

Use a base `id` returned by `bases list`, not a username or an absolute server
path. Paths are relative to that base. `list` returns one page; pass its `next`
unchanged as `--after` until it is null. There is no implicit recursive listing
or automatic pagination.

Prefer `--json` when you need the cursor, area issues, root statistics, or base
metadata. For `bases list`, `list`, and `admin inventory`, `--jsonl` emits one
complete item per line, without the surrounding page or cursor. Warnings use
stderr in all modes. Missing, conflicting, or unknown storage must not be
treated as an empty directory; unknown statistics remain null.

Downloads first obtain a short-lived lease through the authenticated Cloud API,
then stream directly from Filegate. The Filegate public URL must be reachable
from the machine running the CLI. The CLI does not send Cloud credentials to
Filegate or print the lease. Success returns `{path, bytes}`. `--out` is required;
existing files and symlinks are never overwritten. Failed or interrupted
transfers leave no completed output file. Retry by running the command again.
Binary content is saved to disk, not stdout.

## Administer storage

These commands require a Cloud administrator account and use the same server
authorization as the administration UI.

```bash
cld filesv2 admin inventory --area cloud --kind users --json
cld filesv2 admin inventory --area freeipa --kind groups --json
cld filesv2 admin inventory --area freeipa --kind groups --after '<next>' --json
cld filesv2 admin configuration get --json
cld filesv2 admin adopt <identity-uuid> --area cloud --kind users --yes --json
```

`--area` defaults to `cloud`; `--kind` defaults to `users`. Inventory includes
configuration, availability, the current root's capabilities/statistics, one
page of directory entries, `next`, and `issue`. Root statistics cover the whole
root, including when a relative prefix is configured. FreeIPA directories
created outside Cloud are recognized through the filesystem. An unknown state
does not prove an identity or directory was deleted.

Before `admin adopt`, inspect the matching inventory entry and verify its
`identityId`, `path`, and `canAdopt`. This binds an existing directory to its
current eligible identity and leaves its files in place. It does not create
directories. Use it only when the user authorized the assignment; `--yes`
confirms the operation. Read inventory again afterward.

## Change configuration

Read the current configuration, edit the intended fields, then submit the
complete configuration. `get` exposes `tokenConfigured`, never the backend
token. Each area contains `enabled`, `root`, `prefix`, `homes`, `groups`, and
`archive`; the top-level `url` is the Filegate backend URL.

```bash
cld filesv2 admin configuration get --json > ./filesv2.json
# Edit ./filesv2.json before submitting it.
cld filesv2 admin configuration set --input-file ./filesv2.json --json
cld filesv2 admin configuration get --json
```

`set --stdin` is also supported. Inline `--input` is rejected so secrets stay
out of command arguments. Omit `token` or leave it empty to retain the saved
token. A nonempty `token` replaces it; protect any input file containing it and
do not print its contents. `tokenConfigured` from `get` is ignored on input.
Saving replaces both areas' configuration; preserve unrelated settings.

Cloud storage requires local Linux identities. Only POSIX groups have group
storage. FreeIPA storage requires enabled FreeIPA and works independently.
Paths and prerequisites are validated by the server. Uploads, provisioning,
archival, trash, sharing, and inbox commands are not implemented yet.
