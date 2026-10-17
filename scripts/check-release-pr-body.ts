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

function collectingLogger(messages: string[]) {
  const collect = (...values: unknown[]) => {
    messages.push(values.map(String).join(" "));
  };
  return { error: collect, warn: collect, info: collect, debug: collect, trace: collect };
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
  const require = createRequire(import.meta.url);
  const loaded: unknown = require(modulePath);
  if (!isRecord(loaded)) throw new Error("Invalid release-please parser module");
  const bodyClass = loaded.PullRequestBody;
  if ((typeof bodyClass !== "function" && !isRecord(bodyClass)) || !("parse" in bodyClass) || typeof bodyClass.parse !== "function") {
    throw new Error("release-please module does not export PullRequestBody.parse");
  }
  const parse = bodyClass.parse;
  const commitModule: unknown = require(join(directory, "node_modules/release-please/build/src/commit.js"));
  if (!isRecord(commitModule) || typeof commitModule.parseConventionalCommits !== "function") {
    throw new Error("release-please module does not export parseConventionalCommits");
  }
  const parseConventionalCommits = commitModule.parseConventionalCommits;
  const parseBody = (body: string) => {
    const messages: string[] = [];
    const result: unknown = parse(body, collectingLogger(messages));
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
  const parseCommits = (message: string) => {
    const messages: string[] = [];
    const result: unknown = parseConventionalCommits([{ sha: "0", message, files: [] }], collectingLogger(messages));
    if (!Array.isArray(result)) throw new Error("Commit parser returned invalid commits");
    const commits: unknown[] = result;
    const texts: string[] = [];
    for (const commit of commits) {
      if (!isRecord(commit) || typeof commit.bareMessage !== "string" || !Array.isArray(commit.notes)) {
        throw new Error("Commit parser returned an invalid commit");
      }
      texts.push(commit.bareMessage);
      const notes: unknown[] = commit.notes;
      for (const note of notes) {
        if (!isRecord(note) || typeof note.text !== "string") throw new Error("Commit parser returned an invalid note");
        texts.push(note.text);
      }
    }
    return { texts, messages };
  };
  return { parseBody, parseCommits };
}

function report(body: string, findings: string[], messages: string[]): void {
  for (const finding of findings) console.error(finding);
  for (const message of messages) console.error(`release-please: ${message}`);
  const snippets = markupSnippets(body);
  if (snippets.length) console.error(`Likely cause: HTML-like markup: ${snippets.map((snippet) => JSON.stringify(snippet)).join(", ")}`);
  console.error("See docs-site/docs/en/contributing/release-process.md (#1298).");
}

async function resolvePrNumber(number?: string): Promise<string | undefined> {
  if (number !== undefined) {
    if (!/^[1-9]\d*$/.test(number)) throw new Error("Expected a positive PR number");
    return number;
  }
  const eventFile = process.env.GITHUB_EVENT_PATH;
  if (!eventFile || !existsSync(eventFile)) return undefined;
  const event = json(await readFile(eventFile, "utf8"));
  if (!isRecord(event)) throw new Error("Invalid GitHub event: expected an object");
  if (event.pull_request !== undefined) {
    const pr = event.pull_request;
    if (!isRecord(pr) || typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number <= 0) {
      throw new Error("Invalid GitHub event: expected a positive pull_request.number");
    }
    return String(pr.number);
  }
  if (event.merge_group !== undefined) {
    if (!isRecord(event.merge_group) || typeof event.merge_group.head_ref !== "string") {
      throw new Error("Invalid GitHub event: expected merge_group.head_ref");
    }
    const match = /^refs\/heads\/gh-readonly-queue\/.+\/pr-([1-9]\d*)-[0-9a-f]+$/.exec(event.merge_group.head_ref);
    if (!match?.[1]) throw new Error(`Cannot find a pull request number in queue ref: ${event.merge_group.head_ref}`);
    return match[1];
  }
  return undefined;
}

function repositoryName(): string {
  const repository = process.env.GITHUB_REPOSITORY || "k2b-dev/cloud";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GITHUB_REPOSITORY");
  return repository;
}

async function checkMessage(number: string): Promise<boolean> {
  const pr = json(await command("gh", ["api", `repos/${repositoryName()}/pulls/${number}`]));
  if (!isRecord(pr) || typeof pr.title !== "string" || (pr.body !== null && typeof pr.body !== "string")) {
    throw new Error("Invalid pull request response: expected title and body");
  }
  const findings = releaseNoteMarkup(pr.title, pr.body ?? "");
  for (const finding of findings) console.error(finding);
  if (!findings.length) console.log(`PR #${number}: title, body commit headers, and BREAKING CHANGE footers pass.`);
  return findings.length === 0;
}

async function checkPr(number: string, bodyFile?: string): Promise<boolean> {
  // Install first: the check must fetch the live body after this potentially slow step.
  const { parseBody } = await parser();
  const repository = repositoryName();
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
  const { releases, messages } = parseBody(body);
  for (const release of releases) console.log(`${release.component ?? "(unnamed)"} ${release.version ?? "(missing version)"}`);
  const findings = verifyReleaseData(bumpedComponents(configuration, before, after), releases);
  if (findings.length) report(body, findings, messages);
  else console.log(`PR #${number}: release body passes.`);
  return findings.length === 0;
}

async function selfTest(): Promise<boolean> {
  const { parseBody, parseCommits } = await parser();
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
    const { releases, messages } = parseBody(body);
    const findings = verifyReleaseData(bumpedComponents(configuration, before, after), releases);
    const ok = missingCloud ? findings.some((finding) => finding.startsWith("Missing cloud ")) : findings.length === 0;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${missingCloud ? " (expected failure: missing cloud)" : ""}`);
    if (findings.length || !ok) report(body, findings, messages);
    passed &&= ok;
  }
  for (const [name, message, expectMarkup] of [
    ["1227-commit-message.txt", await fixture("1227-commit-message.txt"), true],
    ["whitespace-only footer line", "feat(x): add y\n\nBREAKING CHANGE: migrate\n \t\nUse <dir>\n\nnext <a>", true],
    ["split commit header", "feat(x): add y\n\nSome text\n\nfeat(ui): extra <d>\nwith body\n\nend", true],
    ["nested commit header", "feat: add y\n\nBEGIN_NESTED_COMMIT\nfix(x): use <dir>\nEND_NESTED_COMMIT", true],
    ["inline nested commit", "feat: add y\n\nText BEGIN_NESTED_COMMIT fix: use <dir> END_NESTED_COMMIT more", true],
    ["header without a space", "feat(x): add y\n\nfix:`<dir>`", true],
    ["header with a tab", "feat(x): add y\n\nfix:\t<dir>", true],
    ["capitalized header", "feat(x): add y\n\nFix: cap <dir>", true],
    ["breaking header of a custom type", "feat(x): add y\n\nIntro.\n\nsecurity!: use <dir>", true],
    ["inline hyphenated breaking note", "feat(x): add y\n\nIntro.\n\n- BREAKING-CHANGE: use <dir>", true],
    ["markup in a custom-type line and an indented note", "feat(x): add y\n\nNote: see <x>\n\n- BREAKING CHANGE: use <dir>", false],
    ["clean message", "feat(x): add y\n\nBREAKING CHANGE: migrate to DIR", false],
    ["markup only in prose and a bullet", "fix: add y\n\nUses `<Button>`\n\n- fix: x <c>", false],
  ] as const) {
    const [title = "", ...lines] = message.split("\n");
    const findings = releaseNoteMarkup(title, lines.join("\n"));
    const { texts, messages } = parseCommits(message);
    const parserHasMarkup = texts.some((text) => markupSnippets(text).length > 0);
    const ok = (!parserHasMarkup || findings.length > 0) && (expectMarkup ? parserHasMarkup : findings.length === 0);
    console.log(`${ok ? "PASS" : "FAIL"} ${name} (expected ${expectMarkup ? "markup rejection" : "no lint findings"})`);
    if (!ok) report(message, findings, messages);
    passed &&= ok;
  }
  return passed;
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
    mode = arg === "--pr" ? "pr" : arg === "--message" ? "message" : "self-test";
    const next = args[index + 1];
    if (mode !== "self-test" && next !== undefined && !next.startsWith("--")) {
      number = next;
      index++;
    }
  }
  if (bodyFile && mode !== "pr") throw new Error("--body is only valid with --pr");
  if (help) {
    console.log(`Usage: bun scripts/check-release-pr-body.ts --pr [<number>] [--body <file>]
       bun scripts/check-release-pr-body.ts --self-test
       bun scripts/check-release-pr-body.ts --message [<number>]
       bun scripts/check-release-pr-body.ts --help

--pr: check a live release-please PR. --body checks an edited file.
--self-test: check historical fixtures with the parser pinned in main.yml.
--message: fetch the live PR title and body and check markup copied into release notes.
--pr and --message accept an optional positive PR number. Otherwise, read
      pull_request.number or merge_group.head_ref from GITHUB_EVENT_PATH.
      With no event file or no PR in the event, there is no pull request to check.
      Both use gh auth locally or GH_TOKEN in CI; GITHUB_REPOSITORY defaults to k2b-dev/cloud.
--pr and --self-test download and install the pinned parser into the OS temp directory.
--help: print this usage and exit.`);
    return true;
  }
  if (mode === "self-test") return selfTest();
  if (mode === "pr" || mode === "message") {
    const resolved = await resolvePrNumber(number);
    if (!resolved) {
      console.log("There is no pull request to check.");
      return true;
    }
    return mode === "pr" ? checkPr(resolved, bodyFile) : checkMessage(resolved);
  }
  throw new Error("Choose --pr, --self-test, or --message. Run with --help for usage.");
}

try {
  process.exitCode = (await main()) ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
