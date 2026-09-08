# Cloud website

One Bun service exposes the complete public website:

- `/en` — marketing homepage
- `/en/docs` — Fibel developer documentation
- `/en/ui` — live examples imported from the Cloud UI source
- `/health` — container health endpoint

From the repository root, start the same Linux container on macOS or Linux:

```bash
bun run dev:fibel
```

Development defaults to [http://localhost:4187/en](http://localhost:4187/en).
The command returns after `/health` is ready. The container rebuilds the local
Cloud UI stylesheet when it starts, and Bun reloads it when mounted TypeScript
or component source changes. Run `bun run dev:fibel` again to re-index Markdown;
the cached image is reused and the command waits for the replacement container.

```bash
bun run dev:fibel:logs
bun run dev:fibel:down
```

Set `FIBEL_PORT=4199` on the start command when port `4187` is occupied.

Production builds require `CLOUD_DOCS_SITE_URL`. Set it to the public origin,
without a trailing path, so canonical links, social metadata, `robots.txt`, and
the sitemap use absolute URLs. The intended public origin is
[https://cloud.k2b.dev](https://cloud.k2b.dev), with the documentation MCP at
`https://cloud.k2b.dev/_fibel/mcp`.

```bash
bun run typecheck
CLOUD_DOCS_SITE_URL=https://cloud.k2b.dev bun run build
CLOUD_DOCS_SITE_URL=https://cloud.k2b.dev bun run start
```

Build the deployable container from the repository root:

```bash
docker build \
  --build-arg CLOUD_DOCS_SITE_URL=https://cloud.k2b.dev \
  -f docs-site/Dockerfile \
  -t cloud-website .
docker run --rm \
  -e CLOUD_DOCS_SITE_URL=https://cloud.k2b.dev \
  -p 3000:3000 \
  cloud-website
```

## Release

Run `bun run verify:docs` from this directory before releasing. This checks
the documentation, API reference, compiled examples, UI catalog, and website
build. Example sources live in `examples/cloud-docs` and use this package's
declared dependencies.

[Release instructions](./RELEASING.md) cover npm setup, image publication,
and the checks required before exposing `cloud.k2b.dev`.
