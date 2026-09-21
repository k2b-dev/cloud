// Real model evaluation against disposable data services; never writes to a user's chat.

import { parseArgs } from "node:util";
import { sql } from "bun";
import { resolveAiModel } from "../../cloud/src/ai/settings";

const { values: options } = parseArgs({
  args: Bun.argv.slice(2),
  options: { files: { type: "string" }, help: { type: "boolean", default: false } },
});
if (options.help) {
  console.log(`Usage: bun packages/assistant/scripts/eval-code-mode.ts --files <CSV-directory>

Evaluates Code Mode with the configured AI model against disposable data services.

Options:
  --files <dir>   Directory with the CSV evaluation inputs
  --help          Show this help
`);
  process.exit(0);
}
const inputDirectory = options.files;
if (!inputDirectory) throw new Error("--files <CSV-directory> is required");
const { provider, profile } = await resolveAiModel();
const token = crypto.randomUUID();
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 403 });
    try {
      const input = await request.json();
      return Response.json(await provider.complete({ ...input, signal: request.signal }));
    } catch {
      return Response.json({ error: "Configured provider request failed" }, { status: 502 });
    }
  },
});
try {
  const child = Bun.spawn([process.execPath, new URL("./test-artifacts.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      ASSISTANT_EVAL_FILES: inputDirectory,
      ASSISTANT_EVAL_URL: proxy.url.href,
      ASSISTANT_EVAL_TOKEN: token,
      ASSISTANT_EVAL_MODEL: profile.model,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally {
  proxy.stop(true);
  await sql.close();
}
