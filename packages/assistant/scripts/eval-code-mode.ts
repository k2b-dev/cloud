// Real model evaluation against disposable data services; never writes to a user's chat.

import { parseArgs } from "node:util";
import { sql } from "bun";
import { createAiProvider } from "../../cloud/src/ai/provider";
import { parseAiModelProfiles, resolveAiModel } from "../../cloud/src/ai/settings";
import type { AiResolvedModel } from "../../cloud/src/ai/types";
import { STUDIO_EVAL_CASES } from "../src/artifacts/studio-eval-cases";

const { values: options } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    case: { type: "string", multiple: true },
    out: { type: "string", default: `/tmp/assistant-code-mode-eval/${new Date().toISOString().replace(/[:.]/g, "-")}` },
    concurrency: { type: "string", default: "3" },
    profile: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (options.help) {
  console.log(`Usage: bun packages/assistant/scripts/eval-code-mode.ts [--case <name>]... [--out <dir>] [--concurrency <n>] [--profile <json>]

Lets a real model build the Studio app cases in disposable chats and data services, and measures
whether the first code_check passed and whether the first checked version was presented unchanged.

Cases: ${STUDIO_EVAL_CASES.map((item) => item.name).join(", ")}

Options:
  --case <name>       Run only this case; repeat for several (default: all)
  --out <dir>         Directory for summary.md and one folder per case (default: /tmp/assistant-code-mode-eval/<time>)
  --concurrency <n>   Cases running at the same time (default: 3)
  --profile <json>    One model profile in the ai.model_profiles_json format; its API key comes from
                      ASSISTANT_EVAL_API_KEY. Without it, the configured Cloud default model is used,
                      which needs DATABASE_URL and APP_SECRET of that installation.
  --help              Show this help
`);
  process.exit(0);
}
const unknown = (options.case ?? []).filter((name) => !STUDIO_EVAL_CASES.some((item) => item.name === name));
if (unknown.length) throw new Error(`Unknown case: ${unknown.join(", ")}`);
const concurrency = Number(options.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");

async function model(): Promise<AiResolvedModel> {
  if (!options.profile) return resolveAiModel();
  const { profiles, error } = parseAiModelProfiles(`[${options.profile}]`);
  if (error || profiles.length !== 1) throw new Error(`Invalid --profile: ${error?.message ?? "expected one profile"}`);
  const profile = profiles[0]!;
  return { profile, provider: createAiProvider(profile, process.env.ASSISTANT_EVAL_API_KEY || undefined) };
}
const { provider, profile } = await model();
const token = crypto.randomUUID();
// Credentials stay in this process; the test process reaches the model only through this loopback proxy.
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 403 });
    try {
      const input = await request.json();
      return Response.json(await provider.complete({ ...input, signal: request.signal }));
    } catch (error) {
      console.error("Evaluation provider request failed", error instanceof Error ? error.message : error);
      return Response.json({ error: "Configured provider request failed" }, { status: 502 });
    }
  },
});
try {
  console.log(`Evaluating ${profile.model}; results in ${options.out}`);
  const child = Bun.spawn([process.execPath, new URL("./test-artifacts.ts", import.meta.url).pathname], {
    env: {
      ...process.env,
      ASSISTANT_EVAL_URL: proxy.url.href,
      ASSISTANT_EVAL_TOKEN: token,
      ASSISTANT_EVAL_MODEL: profile.model,
      ASSISTANT_EVAL_REASONING: profile.reasoningEffort ?? "",
      ASSISTANT_EVAL_CASES: (options.case ?? []).join(","),
      ASSISTANT_EVAL_OUT: options.out,
      ASSISTANT_EVAL_CONCURRENCY: String(concurrency),
      ASSISTANT_EVAL_API_KEY: "",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally {
  proxy.stop(true);
  await sql.close();
}
