/**
 * Serves Mail's mailbox on the @k2b/ui v2 pilot with the invented data of the v2 mockup, for looking at it and for
 * screenshots: the real island and controller, server-rendered and hydrated, without a database.
 *
 *   bun packages/mail/scripts/mail-v2-preview.ts [--port 4321] [--host 127.0.0.1] [--now <ISO time>]
 *
 * Open /app/mail/Box001 (the list) or /app/mail/Box001?conversation=Demo01 (list and reader). `?locale=en` for English.
 * Provisional with the pilot.
 */
if (process.argv.includes("--help")) {
  console.info(
    "Usage: bun packages/mail/scripts/mail-v2-preview.ts [--port 4321] [--host 127.0.0.1] [--now <ISO time>]\nServes Mail's v2 pilot with the mockup's invented data.",
  );
  process.exit(0);
}
const option = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const { startMailV2Server, MAIL_V2_PATH } = await import("../src/frontend/mail-v2.browser-server");
// `--now 2026-11-27T10:00:00Z` freezes the demo's clock, as the tests do; the browser should freeze its own to match.
const now = option("--now");
const server = await startMailV2Server({
  port: Number(option("--port") ?? 4321),
  hostname: option("--host") ?? "127.0.0.1",
  ...(now ? { now: () => Date.parse(now) } : {}),
});
console.info(`Mail v2 preview: ${server.url}${MAIL_V2_PATH}?conversation=Demo01`);
