/** Build a trusted acceptance artifact with the actual C16 bundler; never evaluate its Code in Bun. */
import { createHash } from "node:crypto";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CODE_CHECK_LIMITS, codeSdkHash } from "@k2b/cloud/code";
import { z } from "zod";
import { ACCEPTANCE_SOURCE, sdk } from "./test-kit.fixtures";

if (Bun.argv.includes("--help")) {
  console.log("Usage: bun build-code-fixture.ts OUTPUT_JSON\nBuild the trusted C17 acceptance bundle with the C16 worker.");
} else {
  const directory = await mkdtemp(join(tmpdir(), "code-test-build-"));
  const request = join(directory, "request.json");
  const entrypoints = [{ kind: "schedule", entrypoint: "weekly", cron: "0 8 * * *", file: "code.ts", line: 2 }];
  try {
    await writeFile(
      request,
      JSON.stringify({
        entry: "code.ts",
        files: { "code.ts": ACCEPTANCE_SOURCE },
        sdk,
        aiOperations: [],
        entrypoints,
        limits: CODE_CHECK_LIMITS,
      }),
    );
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../cloud/scripts/code-check-worker.ts"), "bundle", request], {
      stdout: "pipe",
      stderr: "pipe",
      env: {},
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Acceptance bundle build failed: ${stderr}`);
    const { bundle } = z.object({ bundle: z.string() }).parse(JSON.parse(stdout));
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    await Bun.write(
      Bun.argv[2]!,
      JSON.stringify({
        bundle,
        manifest: {
          version: 1,
          entrypoints,
          permissions: [{ operation: "spaces.task.create", target: { type: "spaces.space", id: "sp_fixture" }, file: "code.ts", line: 2 }],
          ai: false,
          hashes: {
            source: sha(JSON.stringify({ entry: "code.ts", files: [["code.ts", ACCEPTANCE_SOURCE]] })),
            sdk: codeSdkHash(sdk),
            bundle: sha(bundle),
          },
        },
      }),
    );
  } finally {
    await unlink(request);
    await rmdir(directory);
  }
}
