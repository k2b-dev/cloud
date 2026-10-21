import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

test("Nightly supplies Grids and Chat with the configured public origin", async () => {
  const workflow = z
    .object({
      jobs: z.object({
        "browser-smoke": z.object({ steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })) }),
      }),
    })
    .parse(Bun.YAML.parse(readFileSync(resolve(import.meta.dir, "../../../.github/workflows/nightly.yml"), "utf8")));
  const run = workflow.jobs["browser-smoke"].steps.find((step) => step.name === "Run the Grids, Mail and Chat browser smokes")?.run;
  if (!run) throw new Error("Nightly browser-smoke step missing");
  const start = run.indexOf("failed=()");
  if (start === -1) throw new Error("Nightly browser-smoke loop missing");
  const loop = run.slice(start);
  const child = Bun.spawn(
    [
      "bash",
      "-c",
      `set -euo pipefail
      bun() { printf 'ARGS'; printf ' <%s>' "$@"; printf '\\n'; }
      timeout() { return 0; }
      ${loop}`,
    ],
    {
      env: { PATH: process.env.PATH, APP_URL: "https://cloud.nightly-smoke.test", RUNNER_TEMP: "/unused" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(errors).toBe("");
  expect(code).toBe(0);
  const args = output.split("\n").filter((line) => line.startsWith("ARGS"));
  expect(args.find((line) => line.includes("packages/grids/"))).toContain("<--app-url> <https://cloud.nightly-smoke.test>");
  expect(args.find((line) => line.includes("packages/chat/"))).toContain("<--app-url> <https://cloud.nightly-smoke.test>");
  expect(args.find((line) => line.includes("packages/chat/"))).toContain("<--webkit-endpoint> <ws://127.0.0.1:3333/>");
  expect(args.find((line) => line.includes("packages/mail/"))).not.toContain("<--app-url>");
});
