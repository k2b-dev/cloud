import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import {
  CODE_CHECK_LIMITS,
  type CodeCheckResult,
  type CodeTestCase,
  CodeTestCaseSchema,
  createCodeTestBridge,
  type GeneratedCodeSdk,
  generateCodeSdk,
  validateCodePage,
} from "@k2b/cloud/code";
import { type CapabilityManifest, capabilityActionPolicy } from "@k2b/cloud/contracts";
import { chatCapabilities } from "../../../../chat/src/capabilities";
import { contactsCapabilities } from "../../../../contacts/src/capabilities";
import { aiCapabilities } from "../../../../core/src/capabilities";
import { acceptanceChecker } from "../../../../core/src/code/acceptance.test-fixture";
import { codePolicyPreset, codePolicyRow } from "../../../../core/src/code/policy-contracts";
import { filesCapabilities } from "../../../../filesv2/src/capabilities";
import { mailCapabilities } from "../../../../mail/src/capabilities";
import { notebooksCapabilities } from "../../../../notebooks/src/capabilities";
import { spacesCapabilities } from "../../../../spaces/src/capabilities";

// The skill's examples, templates and fixtures are its contract with Gustav and application authors.
// Each one is checked against an SDK generated from the real manifests of the apps it documents,
// with the AI classification and unattended rules of Core's Code bridge.
const manifests: CapabilityManifest[] = [
  compileCapabilityManifest("core", aiCapabilities),
  compileCapabilityManifest("mail", mailCapabilities),
  compileCapabilityManifest("filesv2", filesCapabilities),
  compileCapabilityManifest("spaces", spacesCapabilities),
  compileCapabilityManifest("chat", chatCapabilities),
  compileCapabilityManifest("notebooks", notebooksCapabilities),
  compileCapabilityManifest("contacts", contactsCapabilities),
];
const OWNER_ID = "Mbx001";
const skillDir = import.meta.dir;
const personal = generateCodeSdk(manifests, { mode: "personal" });
const sdks = new Map<string, GeneratedCodeSdk>([["personal", personal]]);
const sdkFor = (mode: string): GeneratedCodeSdk => {
  const known = sdks.get(mode);
  if (known) return known;
  const [kind, value] = mode.split(" ");
  if (kind !== "resource" || !value) throw new Error(`Unknown check mode "${mode}"`);
  const sdk = generateCodeSdk(manifests, { mode: "resource", owner: { kind: "resource", ref: { type: value, id: OWNER_ID } } });
  sdks.set(mode, sdk);
  return sdk;
};
const notAi = ["core.ai.chat.deliver", "core.ai.chat.run.read"];
const adminPreset = new Map(codePolicyPreset("admin").rules.map((rule) => [rule.row, rule.value]));
/** When a call runs unattended under the default Admin preset, mirroring Core's Code bridge: AI first, then the Action policy. */
const unattended = (capability: string): "automatic" | "admin" | "never" | "omitted" | "missing" => {
  if (personal.manifest.omitted.some((op) => op.capability === capability)) return "omitted";
  const op = personal.manifest.operations.find((candidate) => candidate.capability === capability);
  if (!op) return "missing";
  const policy = capabilityActionPolicy(manifests.find((candidate) => candidate.appId === op.appId)!, op.localId);
  if (op.kind === "action" && (!policy || !("silent" in policy) || policy.routines === false)) return "never";
  const ai = capability.startsWith("core.ai.") && !notAi.includes(capability);
  return adminPreset.get(codePolicyRow(ai ? "ai" : op.kind, policy)) ?? "never";
};

type Example = { where: string; mode: string; fails: string | null; entry: string; source: string; result?: CodeCheckResult };
type Fixture = { where: string; example: Example | null; fixture: CodeTestCase };
const docs: { name: string; text: string }[] = [];
const examples: Example[] = [];
const fixtures: Fixture[] = [];
let checker: Awaited<ReturnType<typeof acceptanceChecker>> | undefined;
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length + 1;

beforeAll(async () => {
  const references = (await readdir(join(skillDir, "references"))).filter((name) => name.endsWith(".md")).sort();
  for (const name of ["SKILL.md", ...references.map((reference) => `references/${reference}`)])
    docs.push({ name, text: await Bun.file(join(skillDir, name)).text() });
  for (const doc of docs) {
    let previous: Example | null = null;
    for (const match of doc.text.matchAll(/(?:<!-- (check: [^>]+?|fixture) -->\n)?```(tsx?|json)\n([\s\S]*?)```/g)) {
      const where = `${doc.name}:${lineOf(doc.text, match.index)}`;
      const [, marker, language, body] = match as unknown as [string, string | undefined, string, string];
      if (language === "json") {
        const value: unknown = JSON.parse(body);
        if (marker === "fixture") fixtures.push({ where, example: previous, fixture: CodeTestCaseSchema.parse(value) });
        continue;
      }
      if (!marker?.startsWith("check: ")) throw new Error(`${where}: a ${language} block needs a <!-- check: … --> line above it`);
      const [mode, fails] = marker.slice("check: ".length).split(" fails ");
      previous = { where, mode: mode!, fails: fails ?? null, entry: `code.${language}`, source: body };
      examples.push(previous);
    }
  }
  for (const name of (await readdir(join(skillDir, "templates"))).sort()) {
    const source = await Bun.file(join(skillDir, "templates", name)).text();
    const mode = source.match(/^\/\/ check: (.+)\n/)?.[1];
    if (!mode) throw new Error(`templates/${name}: the first line must be // check: <owner>`);
    examples.push({ where: `templates/${name}`, mode, fails: null, entry: name.endsWith(".tsx") ? "code.tsx" : "code.ts", source });
  }
  checker = await acceptanceChecker();
  const queue = [...examples];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let example = queue.shift(); example; example = queue.shift()) {
        const sdk = sdkFor(example.mode);
        example.result = await checker!.check({
          files: { [example.entry]: example.source },
          entry: example.entry,
          sdk,
          aiOperations: sdk.manifest.operations.filter((op) => op.capability.startsWith("core.ai.") && !notAi.includes(op.capability)).map((op) => op.capability),
          limits: { ...CODE_CHECK_LIMITS, checkMs: 60_000 },
        });
      }
    }),
  );
}, 600_000);
afterAll(async () => {
  setSystemTime();
  await checker?.close();
});

let fresh = 0;
/** Each run imports the checked bundle anew: the bundle binds its bridge once per module instance. */
const load = async (bundle: string): Promise<Record<string, (input: unknown, bridge: unknown) => Promise<unknown>>> =>
  import(`data:text/javascript;base64,${Buffer.from(`${bundle}\n// run ${++fresh}\n`).toString("base64")}`);
const passing = () => examples.filter((example) => !example.fails && example.result?.ok);

test("every example and template passes the real checker; examples marked to fail report their code", () => {
  expect(examples.length).toBeGreaterThan(30);
  const failures = examples.flatMap((example) => {
    const result = example.result!;
    if (example.fails)
      return !result.ok && result.diagnostics.some((diagnostic) => diagnostic.code === example.fails)
        ? []
        : [`${example.where}: expected ${example.fails}, got ${JSON.stringify(result.ok ? "ok" : result.diagnostics)}`];
    return result.ok ? [] : [`${example.where}: ${result.diagnostics.map((d) => `${d.code} ${d.line}:${d.column} ${d.message}`).join("; ")}`];
  });
  expect(failures).toEqual([]);
});

test("no example calls an operation that never runs unattended", () => {
  // An asking Action never runs unattended in this release; a version that calls one cannot be submitted.
  const never = passing().flatMap((example) =>
    example.result!.ok
      ? example.result!.manifest.permissions.filter((row) => unattended(row.operation) === "never").map((row) => `${example.where}: ${row.operation}`)
      : [],
  );
  expect(never).toEqual([]);
});

test("every fixture runs against the example above it with the fake bridge and meets its expectations", async () => {
  expect(fixtures.length).toBeGreaterThan(2);
  const failures: string[] = [];
  for (const { where, example, fixture } of fixtures) {
    if (!example?.result?.ok) {
      failures.push(`${where}: a fixture follows a checked example that passes`);
      continue;
    }
    const bridge = createCodeTestBridge(sdkFor(example.mode).manifest, fixture.mocks);
    for (const [index, run] of fixture.runs.entries()) {
      bridge.begin();
      setSystemTime(new Date(run.now ?? fixture.now));
      const module = await load(example.result.bundle);
      let outcome: { ok: boolean; error: string | null; value: unknown };
      try {
        const value = await module[run.entrypoint]!(run.input, bridge);
        outcome = { ok: true, error: null, value: value ?? null };
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error), value: null };
      }
      // A missing or invalid mock fails the case even when the Code catches it.
      const fixtureFailure = bridge.failure();
      if (fixtureFailure) outcome = { ok: false, error: fixtureFailure, value: null };
      const calls = bridge.calls();
      const expected = run.expect ?? {};
      const label = `${where} run ${index + 1}`;
      if (expected.ok !== undefined && expected.ok !== outcome.ok) failures.push(`${label}: ok ${outcome.ok} (${outcome.error})`);
      if (expected.error !== undefined && expected.error !== outcome.error) failures.push(`${label}: error ${outcome.error}`);
      if (expected.value !== undefined && JSON.stringify(expected.value) !== JSON.stringify(outcome.value))
        failures.push(`${label}: value ${JSON.stringify(outcome.value)}`);
      if (expected.calls) {
        if (expected.calls.length !== calls.length) failures.push(`${label}: ${calls.length} calls ${JSON.stringify(calls.map((c) => c.operation))}`);
        for (const [position, call] of expected.calls.entries())
          for (const [field, value] of Object.entries(call))
            if (JSON.stringify(value) !== JSON.stringify((calls[position] as Record<string, unknown> | undefined)?.[field]))
              failures.push(`${label}: call ${position + 1} ${field} is ${JSON.stringify((calls[position] as Record<string, unknown> | undefined)?.[field])}`);
      }
    }
  }
  setSystemTime();
  expect(failures).toEqual([]);
});

test("pages that need no data render a valid page tree", async () => {
  const failures: string[] = [];
  let rendered = 0;
  for (const example of passing()) {
    if (!example.result?.ok) continue;
    for (const entry of example.result.manifest.entrypoints) {
      if (entry.kind !== "route" || entry.route?.method !== "GET" || entry.route.path.includes(":")) continue;
      const bridge = createCodeTestBridge(sdkFor(example.mode).manifest, []);
      const module = await load(example.result.bundle);
      const request = { method: "GET", path: entry.route.path, query: "", params: {}, contentType: "text/plain", body: "", user: { id: "u1", groups: [] } };
      try {
        const response = (await module[entry.entrypoint]!(request, bridge)) as { kind: string; tree?: unknown };
        if (response.kind !== "page") continue;
        validateCodePage(response.tree, "c_skill");
        rendered++;
      } catch (error) {
        // Pages that read data need fixtures; the checker already proved their types.
        if (bridge.failure() === "code_test_missing_mock") continue;
        failures.push(`${example.where} ${entry.entrypoint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  expect(failures).toEqual([]);
  expect(rendered).toBeGreaterThan(3);
});

test("every capability and event the skill names exists in the generated SDK", () => {
  const known = new Set([
    ...personal.manifest.operations.map((op) => op.capability),
    ...personal.manifest.omitted.map((op) => op.capability),
    ...personal.manifest.events.map((event) => event.type),
    ...personal.manifest.handles.flatMap((handle) => (handle.type ? [handle.type] : [])),
  ]);
  const apps = manifests.map((manifest) => manifest.appId).join("|");
  const missing = docs.flatMap((doc) =>
    [...doc.text.matchAll(new RegExp(`\`((?:${apps})\\.[a-z][a-z0-9.-]*[a-z0-9])\``, "g"))]
      .map((match) => match[1]!)
      .filter((name) => !known.has(name))
      .map((name) => `${doc.name}: ${name}`),
  );
  expect(missing).toEqual([]);
});

test("the capability tables state when each Action runs and list every Action of the documented apps", () => {
  const doc = docs.find((candidate) => candidate.name === "references/capabilities.md")!.text;
  const words: Record<string, string> = { automatic: "automatic", "admin approval": "admin", never: "never", "not in the SDK": "omitted" };
  const listed = new Map<string, string>();
  for (const match of doc.matchAll(/^\| `([a-z0-9.-]+)` \|.*\| ([a-zA-Z ]+) \|$/gm)) listed.set(match[1]!, match[2]!.trim());
  const wrong: string[] = [];
  for (const [capability, said] of listed)
    if (words[said] !== unattended(capability)) wrong.push(`${capability}: the table says "${said}", the SDK and Admin preset give ${unattended(capability)}`);
  const documented = (capability: string) => /^(mail|spaces|chat|notebooks|contacts|filesv2)\./.test(capability) || capability.startsWith("core.ai.");
  for (const op of personal.manifest.operations)
    if (op.kind === "action" && documented(op.capability) && !listed.has(op.capability))
      wrong.push(`${op.capability}: Action missing from the capability tables`);
  expect(wrong).toEqual([]);
});
