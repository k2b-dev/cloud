### An island chunk built by another test's plugin

- **What happened:** Mail's v2 pilot browser tests passed alone and failed in CI's Mail "rest" part with `ENOENT` for the pilot island's chunk in their `_ssr/` directory. That part runs every file in one `bun test` process.
- **Root cause:** `registerSsrTestPlugin()` registers a process-wide `Bun.plugin`, and the plugin that first loads an island module compiles it. `mailbox-page.render.test.ts` registered its own plugin and loaded the pilot island first. The v2 harness's plugin therefore never built its islands, and the harness served `/_ssr/` from a directory that stayed empty.
- **Error class:** A test harness that relies on process-global registration order, so its result depends on which test files share its process.
- **Guard:** The v2 harness builds its island chunks itself with `Bun.build` and its own `createConfig(...).plugin()` into a directory of its own. Island ids follow the file's path, so the chunks match the markup whichever plugin rendered it. `mail-v2.browser-server.test.ts` loads the island through another plugin first and requires every chunk the page names. It failed before the change.
