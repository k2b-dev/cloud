# Spike: Solid 2 + @k2b/ssr islands + @k2b/ui v2 (22.11.2026)

Branch `spike/solid2-ui-v2`, not for `main`. This folder is not in the workspace list and not in CI.
Screenshots: https://artifacts.qdt-dev-1.k2b.dev/cloud-dev/ui-v2-spike/

## Run it

```bash
cd spike/solid2-demo
bun install                      # own node_modules: solid-js 2.0.3, @solidjs/web 2.0.3, @ui-sdk/solid beta.14
ln -sfn spike/solid2-demo/node_modules ../../node_modules   # local only: packages/ssr and packages/ui/src/v2 resolve Solid 2 from here
NODE_ENV=development bun --conditions=solid --preload=./scripts/preload.ts src/server.tsx   # http://localhost:4391/mail and /dnd
bun test/e2e.ts chromium --shots # SSR, hydration, ui-sdk overlays, layoutProblems({ flat: true }), screenshots in shots/
bun test/dnd.ts chromium --shots # sorting and drag onto a folder: mouse, keyboard, touch (Chromium only, via CDP)
```

`--conditions=solid` matters on the server: `@ui-sdk/solid` ships its JSX source under the `solid` export condition and
precompiled DOM output as `default`, which cannot render on the server.

WebKit does not start on the VM host. Run the same scripts in the Playwright image
(`mcr.microsoft.com/playwright:v1.65.0-noble`) with bun and the worktree mounted, and pass `webkit` as the first argument.

## What is in here

| Part | Where | Size |
| --- | --- | --- |
| `@k2b/ssr` on Solid 2, with island hydration | `packages/ssr/src/*` (`island-server.ts` is new) | 6 files, +148 −75 lines |
| `@k2b/ui` v2 draft | `packages/ui/src/v2/` | primitives 325, overlays 145, drag and drop 302, icons 26, overlay scrollbar 150 (taken over), CSS 296 lines; `layout-check.ts` copied from `fix/flat-layout-guards` |
| demo app | `spike/solid2-demo/src` | `/mail` (list, detail, 3 islands) and `/dnd` (1 island) |
| stdlib `mutation` + `hotkeys` on Solid 2 | `stdlib-solid2.patch` (stdlib branch `spike/solid2`, local) | 2 files |

Findings, effort and the proposed v2 architecture: `FINDINGS.md`.
