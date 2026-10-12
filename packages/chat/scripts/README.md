# Chat scripts

- `browser-smoke.ts` — Playwright smoke against a running loopback stack with Accounts and Chat (Chromium desktop and WebKit phone): `bun packages/chat/scripts/browser-smoke.ts --base-url http://localhost:3000`; use `--app-url` when the public origin differs, `--webkit-endpoint` for WebKit in the Playwright image (see contributing/testing.md, Run WebKit locally), and `DATABASE_URL` to delete the chat after the run.
