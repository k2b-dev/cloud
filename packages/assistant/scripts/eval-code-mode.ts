// Real model evaluation against disposable data services; never writes to a user's chat.
import { resolveAiModel } from "../../cloud/src/ai/settings";
import { sql } from "bun";
const inputDirectory = Bun.argv[2] ?? process.env.ASSISTANT_EVAL_FILES;
if (!inputDirectory) throw new Error("Usage: bun packages/assistant/scripts/eval-code-mode.ts <CSV-directory>");
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
