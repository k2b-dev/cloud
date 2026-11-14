/** Standalone checker role, separate from the credential-bearing runner supervisor.
 * The trusted host writes one request to stdin and receives one result on stdout. No source executes here. */

import { dirname, join, resolve } from "node:path";
import { CODE_CHECK_LIMITS, type CodeCheckHost, type CodeCheckRequest, checkCode } from "../src/code";

if (Bun.argv.includes("--help")) {
  console.log(
    "Usage: bun checker.ts < REQUEST.json\nChecks Code with tsgo, static permission analysis and ESM bundling; emits CodeCheckResult JSON.",
  );
} else {
  const source = import.meta.path.endsWith(".ts");
  const host: CodeCheckHost = source
    ? {
        isolate: resolve(import.meta.dir, "../../runner/checker-isolate"),
        compiler: join(
          dirname(
            Bun.resolveSync(
              `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
              dirname(Bun.resolveSync("typescript/package.json", import.meta.dir)),
            ),
          ),
          "lib/tsc",
        ),
        worker: resolve(import.meta.dir, "code-check-worker.ts"),
        bun: process.execPath,
      }
    : {
        isolate: join(import.meta.dir, "checker-isolate"),
        compiler: join(import.meta.dir, "compiler/tsc"),
        worker: join(import.meta.dir, "check-worker.js"),
        bun: process.execPath,
      };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of Bun.stdin.stream()) {
      bytes += chunk.byteLength;
      if (bytes > CODE_CHECK_LIMITS.requestBytes) throw new Error("code_request_limit");
      chunks.push(chunk);
    }
    const request: CodeCheckRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    console.log(JSON.stringify(await checkCode(request, host, controller.signal)));
  } catch {
    console.log(
      JSON.stringify({
        ok: false,
        diagnostics: [
          { code: "code_invalid_request", message: "Ungültiger oder zu großer Prüfauftrag.", file: "code.ts", line: 1, column: 1 },
        ],
      }),
    );
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}
