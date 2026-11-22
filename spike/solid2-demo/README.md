# Spike: Solid 2 + @k2b/ssr islands + @k2b/ui v2 (22.11.2026)

Branch `spike/solid2-ui-v2`, not for `main`. This folder is not in the workspace list and not in CI.

## Run it

```bash
cd spike/solid2-demo
bun install                      # own node_modules: solid-js 2.0.3, @solidjs/web 2.0.3, @ui-sdk/solid beta.14
ln -sfn spike/solid2-demo/node_modules ../../node_modules   # local only: packages/ssr and packages/ui/src/v2 resolve Solid 2 from here
NODE_ENV=development bun --conditions=solid --preload=./scripts/preload.ts src/server.tsx   # http://localhost:4391/mail
bun test/e2e.ts chromium --shots # SSR, islands, ui-sdk, layoutProblems({ flat: true }), screenshots in shots/
```

`--conditions=solid` matters on the server: `@ui-sdk/solid` ships its JSX source under the `solid` export condition and
precompiled DOM output as `default`, which cannot render on the server.

## What is in here

| Part | Where | Size |
| --- | --- | --- |
| `@k2b/ssr` on Solid 2 | `packages/ssr/src/*` | 5 files, +43 −28 lines |
| `@k2b/ui` v2 draft | `packages/ui/src/v2/` | primitives 325, overlays 145, icons 25, overlay scrollbar 150 (taken over), CSS 272 lines; `layout-check.ts` copied from `fix/flat-layout-guards` |
| demo app | `spike/solid2-demo/src` | mailbox list + detail, 3 islands, ~350 lines without data |
| stdlib `mutation` + `hotkeys` on Solid 2 | `stdlib-solid2.patch` (stdlib branch `spike/solid2`, local) | 2 files |

Findings: see the report in the coordinator thread and `FINDINGS.md`.
