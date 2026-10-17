import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  bumpedComponents,
  markupSnippets,
  type ReleaseConfig,
  type ReleaseData,
  releaseNoteMarkup,
  verifyReleaseData,
} from "./release-pr-body";

const root = resolve(import.meta.dir, "..");
const run = promisify(execFile);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isManifest = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((version) => typeof version === "string");
const json = (text: string): unknown => JSON.parse(text);

function manifest(value: unknown): Record<string, string> {
  if (!isManifest(value)) throw new Error("Release manifest must map paths to version strings");
  return value;
}

async function config(): Promise<ReleaseConfig> {
  const value = json(await readFile(join(root, "release-please-config.json"), "utf8"));
  if (!isRecord(value) || !isRecord(value.packages)) throw new Error("Release config must contain packages");
  const packages = Object.entries(value.packages).map(([path, entry]) => {
    if (!isRecord(entry) || (entry.component !== undefined && typeof entry.component !== "string")) {
      throw new Error(`Invalid release config for ${path}`);
    }
    return [path, { component: entry.component }] as const;
  });
  return { packages: Object.fromEntries(packages) };
}

async function command(file: string, args: string[], cwd = root, timeout = 30_000): Promise<string> {
  try {
    const result = await run(file, args, {
      cwd,
      timeout,
      killSignal: "SIGKILL",
      env: { ...process.env, npm_config_cache: join(tmpdir(), "release-please-npm-cache") },
    });
    return result.stdout;
  } catch (cause) {
    const output = isRecord(cause) ? [cause.stdout, cause.stderr].filter((value) => typeof value === "string").join("\n") : "";
    throw new Error(
      `${file} ${args.join(" ")} failed (timeout ${timeout} ms): ${cause instanceof Error ? cause.message : String(cause)}\n${output}`,
      { cause },
    );
  }
}

async function parser() {
  const workflow = await readFile(join(root, ".github/workflows/main.yml"), "utf8");
  const pins = new Set(
    [...workflow.matchAll(/\buses:\s*googleapis\/release-please-action@([0-9a-f]{40})(?=\s|$)/gi)].map((match) => match[1]),
  );
  const [sha] = pins;
  if (pins.size !== 1 || !sha) throw new Error("main.yml must pin exactly one distinct 40-hex release-please-action SHA");
  const directory = join(tmpdir(), `release-please-action-${sha}`);
  const modulePath = join(directory, "node_modules/release-please/build/src/util/pull-request-body.js");
  if (!existsSync(modulePath)) {
    console.log(`Installing the release-please parser from release-please-action@${sha}`);
    await mkdir(directory, { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) {
      const response = await fetch(`https://raw.githubusercontent.com/googleapis/release-please-action/${sha}/${file}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Downloading ${file} failed: HTTP ${response.status} ${response.statusText}`);
      await writeFile(join(directory, file), await response.text());
    }
    await command("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], directory, 300_000);
  }
  const loaded: unknown = createRequire(import.meta.url)(modulePath);
  if (!isRecord(loaded)) throw new Error("Invalid release-please parser module");
  const bodyClass = loaded.PullRequestBody;
  if ((typeof bodyClass !== "function" && !isRecord(bodyClass)) || !("parse" in bodyClass) || typeof bodyClass.parse !== "function") {
    throw new Error("release-please module does not export PullRequestBody.parse");
  }
  const parse = bodyClass.parse;
  return (body: string) => {
    const messages: string[] = [];
    const collect = (...values: unknown[]) => {
      messages.push(values.map(String).join(" "));
    };
    const result: unknown = parse(body, { error: collect, warn: collect, info() {}, debug() {}, trace() {} });
    const releases: ReleaseData[] = [];
    if (result !== undefined) {
      if (!isRecord(result) || !Array.isArray(result.releaseData)) throw new Error("Parser returned invalid releaseData");
      for (const entry of result.releaseData) {
        if (!isRecord(entry) || typeof entry.notes !== "string" || (entry.component !== undefined && typeof entry.component !== "string")) {
          throw new Error("Parser returned an invalid release entry");
        }
        releases.push({
          component: entry.component,
          version: entry.version === undefined ? undefined : String(entry.version),
          notes: entry.notes,
        });
      }
    }
    return { releases, messages };
  };
}

function report(body: string, findings: string[], messages: string[]): void {
  for (const finding of findings) console.error(finding);
  for (const message of messages) console.error(`release-please: ${message}`);
  const snippets = markupSnippets(body);
  if (snippets.length) console.error(`Likely cause: HTML-like markup: ${snippets.map((snippet) => JSON.stringify(snippet)).join(", ")}`);
  console.error("See docs-site/docs/en/contributing/release-process.md (#1298).");
}

async function checkPr(number: string, bodyFile?: string): Promise<boolean> {
  // Install first: the check must fetch the live body after this potentially slow step.
  const parse = await parser();
  const repository = process.env.GITHUB_REPOSITORY || "k2b-dev/cloud";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GITHUB_REPOSITORY");
  const pr = json(await command("gh", ["api", `repos/${repository}/pulls/${number}`]));
  if (!isRecord(pr) || !isRecord(pr.head) || typeof pr.head.ref !== "string")
    throw new Error("Invalid pull request response: missing head.ref");
  if (!pr.head.ref.startsWith("release-please--")) {
    console.log(`PR #${number} is not a release-please PR; skipping.`);
    return true;
  }
  if (
    !isRecord(pr.base) ||
    typeof pr.base.sha !== "string" ||
    typeof pr.head.sha !== "string" ||
    (pr.body !== null && typeof pr.body !== "string")
  ) {
    throw new Error("Invalid pull request response: expected base/head SHA and body");
  }
  const readManifest = async (sha: string) => {
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("Invalid pull request SHA");
    const value = json(await command("gh", ["api", `repos/${repository}/contents/.release-please-manifest.json?ref=${sha}`]));
    if (
      !isRecord(value) ||
      value.encoding !== "base64" ||
      typeof value.content !== "string" ||
      !/^[A-Za-z0-9+/=\s]+$/.test(value.content)
    ) {
      throw new Error(`Invalid manifest contents response at ${sha}`);
    }
    return manifest(json(Buffer.from(value.content, "base64").toString("utf8")));
  };
  const configuration = await config();
  const before = await readManifest(pr.base.sha);
  const after = await readManifest(pr.head.sha);
  const body = bodyFile ? await readFile(bodyFile, "utf8") : (pr.body ?? "");
  const { releases, messages } = parse(body);
  for (const release of releases) console.log(`${release.component ?? "(unnamed)"} ${release.version ?? "(missing version)"}`);
  const findings = verifyReleaseData(bumpedComponents(configuration, before, after), releases);
  if (findings.length) report(body, findings, messages);
  else console.log(`PR #${number}: release body passes.`);
  return findings.length === 0;
}

async function selfTest(): Promise<boolean> {
  const parse = await parser();
  const configuration = await config();
  const fixture = (name: string) => readFile(join(root, "scripts/fixtures/release-pr-body", name), "utf8");
  let passed = true;
  for (const [name, manifests, missingCloud] of [
    ["1248-as-merged.md", "1248", true],
    ["1248-recovered.md", "1248", false],
    ["1195.md", "1195", false],
  ] as const) {
    const body = await fixture(name);
    const before = manifest(json(await fixture(`${manifests}-manifest-before.json`)));
    const after = manifest(json(await fixture(`${manifests}-manifest-after.json`)));
    const { releases, messages } = parse(body);
    const findings = verifyReleaseData(bumpedComponents(configuration, before, after), releases);
    const ok = missingCloud ? findings.some((finding) => finding.startsWith("Missing cloud ")) : findings.length === 0;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${missingCloud ? " (expected failure: missing cloud)" : ""}`);
    if (findings.length || !ok) report(body, findings, messages);
    passed &&= ok;
  }
  const message = await fixture("1227-commit-message.txt");
  const [title = "", ...lines] = message.split("\n");
  const findings = releaseNoteMarkup(title, lines.join("\n"));
  const ok = findings.length > 0;
  console.log(`${ok ? "PASS" : "FAIL"} 1227-commit-message.txt (expected markup rejection)`);
  for (const finding of findings) console.log(finding);
  return passed && ok;
}

async function main(): Promise<boolean> {
  const args = process.argv.slice(2);
  let mode: "pr" | "self-test" | "message" | undefined;
  let number: string | undefined;
  let bodyFile: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--body") {
      const file = args[++index];
      if (bodyFile || !file || file.startsWith("--")) throw new Error("--body requires exactly one file");
      bodyFile = file;
      continue;
    }
    if (arg !== "--pr" && arg !== "--self-test" && arg !== "--message")
      throw new Error(`Unknown argument: ${arg}. Run with --help for usage.`);
    if (mode) throw new Error("Choose exactly one of --pr, --self-test, or --message");
    if (arg === "--pr") {
      mode = "pr";
      number = args[++index];
      if (!number || !/^[1-9]\d*$/.test(number)) throw new Error("--pr requires a positive PR number");
    } else mode = arg === "--message" ? "message" : "self-test";
  }
  if (bodyFile && mode !== "pr") throw new Error("--body is only valid with --pr");
  if (help) {
    console.log(`Usage: bun scripts/check-release-pr-body.ts --pr <number> [--body <file>]
       bun scripts/check-release-pr-body.ts --self-test
       bun scripts/check-release-pr-body.ts --message
       bun scripts/check-release-pr-body.ts --help

--pr: check a live release-please PR (GITHUB_REPOSITORY defaults to k2b-dev/cloud).
      Uses gh auth locally or GH_TOKEN in CI. --body checks an edited file.
--self-test: check historical fixtures with the parser pinned in main.yml.
--message: check PR_TITLE and PR_BODY for markup copied into release notes.
--pr and --self-test download and install the pinned parser into the OS temp directory.
--help: print this usage and exit.`);
    return true;
  }
  if (mode === "pr" && number) return checkPr(number, bodyFile);
  if (mode === "self-test") return selfTest();
  if (mode === "message") {
    if (process.env.PR_TITLE === undefined || process.env.PR_BODY === undefined) throw new Error("--message requires PR_TITLE and PR_BODY");
    const findings = releaseNoteMarkup(process.env.PR_TITLE, process.env.PR_BODY);
    for (const finding of findings) console.error(finding);
    if (!findings.length) console.log("PR title and BREAKING CHANGE footers pass.");
    return findings.length === 0;
  }
  throw new Error("Choose --pr, --self-test, or --message. Run with --help for usage.");
}

try {
  process.exitCode = (await main()) ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
