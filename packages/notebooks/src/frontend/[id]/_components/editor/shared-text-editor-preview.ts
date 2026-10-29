/** Fictional development fixture, shared with the browser regression suite. */
import { startNotebookEditorFixture } from "./shared-text-editor.browser-fixture";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: bun --no-env-file shared-text-editor-preview.ts [port]\nServes the Notebook editor with fictional data on loopback. Stop with Ctrl-C.",
  );
  process.exit(0);
}
const port = Number(process.argv[2] ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Invalid port");
const server = await startNotebookEditorFixture(port);
console.log(server.url.href);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
