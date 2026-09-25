# Cloud CLI

`cld` is the first-party Cloud CLI for local operators and coding agents.

## Install

Install the standalone binary and, when prompted, the Cloud CLI agent skill from
any Cloud instance:

```bash
curl -fsSL https://cloud.example.com/cli | sh
cld login --server https://cloud.example.com
```

The installer places `cld` in `~/.local/bin`, verifies SHA-256 checksums, and
verifies their signature with Cosign 2.4.2 or newer when it is available. It
can also install the `cloud-cli` skill into `~/.agents/skills` and optionally
symlink it into `~/.claude/skills/cloud-cli`. Run `cld update` to install the
latest CLI release and refresh the skill without changing profiles or OAuth
credentials.

Useful installer flags:

```bash
curl -fsSL https://cloud.example.com/cli | sh -s -- --yes
curl -fsSL https://cloud.example.com/cli | sh -s -- --no-skills
curl -fsSL https://cloud.example.com/cli | sh -s -- --claude-symlink
```

On a machine without a browser, such as a server reached over SSH, sign in
with a code instead. Open the printed URL on your laptop or phone, sign in,
and approve the code:

```bash
cld login --server https://cloud.example.com --device
```

In an SSH session or with `--no-open`, the normal `cld login` suggests
`--device`. Run `cld login --help` for all options.

Run it from the workspace without installing a binary:

```bash
bun run packages/cloud-cli/src/index.ts --server http://localhost:3000 --token cld_... notebooks list
```

## Plugins

Third-party applications ship their `cld` commands as plugins:

```bash
cld plugins install @example/inventory-cli@1.4.0
cld plugins list
cld plugins run inventory items list
cld plugins remove inventory
```

Plugins live in `~/.config/cloud/cld/plugins/<id>/` and run unsandboxed with
your Cloud credentials. See
[Application CLI modules](../../docs-site/docs/en/platform/cli-modules.md) for
the manifest and the security model.

## Profiles

Profiles live in `~/.config/cloud/cld/config.json` by default. The directory is
written with `0700` and the config file with `0600`.
OAuth credentials stay bound to the profile's Cloud server. To move a profile
to another server, run `cld login <profile> --server <url>` instead of
overriding `--server` or `CLD_SERVER` on an existing OAuth profile.
Interactive login always uses Cloud's protected first-party `cloud-cli` OAuth
client. Dynamic registration is reserved for external clients that Cloud does
not know in advance.
The server value must be an `https://` origin without credentials, a path,
query parameters, or a fragment. Local development may use `http://` only on
the exact `localhost`, `127.0.0.1`, or `::1` loopback hosts.
Re-login replaces and remotely revokes the previous refresh grant. `cld
logout` revokes the current grant and removes its local or fd0-backed refresh
token reference.

```bash
bun run packages/cloud-cli/src/index.ts profile set \
  --server http://localhost:3000 \
  --token cld_...

bun run packages/cloud-cli/src/index.ts notebooks list
```

Token lookup order:

1. `--token`
2. `CLD_TOKEN`
3. `--token-file`
4. `--fd0`
5. `--token-command`
6. the selected profile's token provider

fd0 example:

```bash
bun run packages/cloud-cli/src/index.ts profile set local \
  --server http://localhost:3000 \
  --fd0 cloud-local-token \
  --fd0-scope stuve
```

## Notebooks

```bash
bun run packages/cloud-cli/src/index.ts notebooks list
bun run packages/cloud-cli/src/index.ts notebooks tree <notebook>
bun run packages/cloud-cli/src/index.ts notebooks search <notebook> "query"
bun run packages/cloud-cli/src/index.ts notebooks read <notebook> <note> --number-lines --blocks
bun run packages/cloud-cli/src/index.ts notebooks edit <notebook> <note> --dry-run --insert-after-line 1 --content "New line"
```
