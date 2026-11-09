import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import {
  type CapabilityManifest,
  CapabilityManifestSchema,
  CodeHttpRequestSchema,
  CodeSecretBindingSchema,
  capabilityActionPolicy,
} from "@k2b/cloud/contracts";
import { z } from "zod";
import { acceptanceChecker } from "../../../../core/src/code/acceptance.test-fixture";
import { codePolicyPreset, codePolicyRow } from "../../../../core/src/code/policy-contracts";

// The skill's examples, templates and fixtures are its contract with Gustav and application authors.
// Each one is checked against an SDK generated from the real manifests of the apps it documents,
// with the AI classification and unattended rules of Core's Code bridge. The apps resolve their own
// `@/` imports, which this package's typecheck cannot follow, so a child process compiles them.
const APPS = [
  ["core", "core/src/capabilities.ts", "aiCapabilities"],
  ["mail", "mail/src/capabilities.ts", "mailCapabilities"],
  ["filesv2", "filesv2/src/capabilities.ts", "filesCapabilities"],
  ["spaces", "spaces/src/capabilities.ts", "spacesCapabilities"],
  ["chat", "chat/src/capabilities.ts", "chatCapabilities"],
  ["notebooks", "notebooks/src/capabilities.ts", "notebooksCapabilities"],
  ["contacts", "contacts/src/capabilities.ts", "contactsCapabilities"],
  ["grids", "grids/src/capabilities.ts", "gridsCapabilities"],
] as const;
const packages = resolve(import.meta.dir, "../../../..");
const compile = Bun.spawnSync(
  [
    process.execPath,
    "-e",
    `const { compileCapabilityManifest } = await import(${JSON.stringify(join(packages, "cloud/src/capabilities/testing.ts"))});
const apps = ${JSON.stringify(APPS.map(([id, file, name]) => [id, join(packages, file), name]))};
const out = [];
for (const [id, file, name] of apps) out.push(compileCapabilityManifest(id, (await import(file))[name]));
// The fictional import app with a FileRef write stream, shared with the cloud checker test.
out.push((await import(${JSON.stringify(join(packages, "cloud/src/code/file-ref.test-fixture.ts"))})).fileImportManifest());
process.stdout.write(JSON.stringify(out));`,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
if (compile.exitCode !== 0) throw new Error(`Compiling app manifests failed: ${compile.stderr.toString()}`);
const manifests: CapabilityManifest[] = z.array(CapabilityManifestSchema).parse(JSON.parse(compile.stdout.toString()));
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
  const list = async (folder: string) =>
    (await readdir(join(skillDir, folder)))
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => `${folder}/${name}`);
  // Templates live in templates/ and ship to the Assistant as references/template-<name>.md.
  for (const name of ["SKILL.md", ...(await list("references")), ...(await list("templates"))])
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
    if (doc.name.startsWith("templates/") && !examples.some((example) => example.where.startsWith(`${doc.name}:`) && !example.fails))
      throw new Error(`${doc.name}: a template holds one complete checked example`);
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
          aiOperations: sdk.manifest.operations
            .filter((op) => op.capability.startsWith("core.ai.") && !notAi.includes(op.capability))
            .map((op) => op.capability),
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

const random = Math.random;
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
    return result.ok
      ? []
      : [`${example.where}: ${result.diagnostics.map((d) => `${d.code} ${d.line}:${d.column} ${d.message}`).join("; ")}`];
  });
  expect(failures).toEqual([]);
});

test("no example calls an operation that never runs unattended", () => {
  // An asking Action never runs unattended in this release; a version that calls one cannot be submitted.
  const never = passing().flatMap((example) =>
    example.result!.ok
      ? example
          .result!.manifest.permissions.filter((row) => unattended(row.operation) === "never")
          .map((row) => `${example.where}: ${row.operation}`)
      : [],
  );
  expect(never).toEqual([]);
});

test("the webhook example declares the bound service and acts only on confirmed service state", async () => {
  const example = passing().find((example) => example.source.includes("secrets.EVENTS_API"));
  if (!example?.result?.ok) throw new Error("Missing checked webhook example");
  expect(example.result.manifest.internet).toEqual(["https://events.example.com"]);
  const section = docs.find((doc) => doc.name === "references/access.md")!.text.split("## Webhooks (R1: ohne Secret)")[1]!;
  const binding = CodeSecretBindingSchema.parse(JSON.parse(section.match(/```json\n([\s\S]*?)```/)![1]!));
  expect(example.result.manifest.internet).toContain(binding.origin);
  for (const status of ["ready", "cancelled", "malformed"]) {
    const calls: { operation: string; input: unknown }[] = [];
    const bridge = {
      async call(operation: string, input: unknown) {
        calls.push({ operation, input });
        if (operation === "http.fetch") {
          const request = CodeHttpRequestSchema.parse(input);
          expect(request.url).toBe(`${binding.origin}${binding.pathPrefix}/evt_1`);
          expect(binding.headers).toContain("authorization");
          expect(request.headers).toEqual({ authorization: "Bearer [secret:EVENTS_API]" });
          return {
            status: 200,
            headers: {},
            body: Buffer.from(
              status === "malformed" ? "not-json" : JSON.stringify({ id: "evt_1", status, title: "Bestätigte Rückmeldung" }),
            ).toString("base64"),
          };
        }
        expect(operation).toBe("spaces.task.create");
        expect(input).toMatchObject({
          call: { input: { title: "Bestätigte Rückmeldung" } },
          metadata: { idempotencyKey: "service-event:evt_1" },
        });
        return {};
      },
    };
    const module = await load(example.result.bundle);
    const response = await module["route:POST:/hooks/events"]!(
      {
        codeId: "c_webhook",
        method: "POST",
        path: "/hooks/events",
        query: "",
        params: {},
        contentType: "application/json",
        body: JSON.stringify({ id: "evt_1", status: "ready", title: "Untrusted title" }),
        user: null,
      },
      bridge,
    );
    expect(response).toMatchObject({ kind: "json", status: status === "ready" ? 200 : status === "malformed" ? 502 : 409 });
    expect(calls.map((call) => call.operation)).toEqual(status === "ready" ? ["http.fetch", "spaces.task.create"] : ["http.fetch"]);
  }
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
      // The runner's seeded generator, reset for each invocation (packages/runner/src/test-kit.ts).
      let seed = fixture.seed >>> 0;
      Math.random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const module = await load(example.result.bundle);
      let outcome: { ok: boolean; error: string | null; value: unknown };
      try {
        const entry = example.result.manifest.entrypoints.find((entry) => entry.entrypoint === run.entrypoint);
        const input =
          entry?.kind === "schedule"
            ? {
                runId: `test-${index}`,
                scheduledAt: run.scheduledAt === undefined ? new Date(run.now ?? fixture.now).toISOString() : run.scheduledAt,
                input: run.input,
              }
            : run.input;
        const value = await module[run.entrypoint]!(input, bridge);
        outcome = { ok: true, error: null, value: value ?? null };
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error), value: null };
      } finally {
        Math.random = random;
      }
      const calls = bridge.calls();
      const expected = run.expect ?? {};
      const label = `${where} run ${index + 1}`;
      // As in the runner's test kit: a missing or invalid mock fails the case even when the Code catches it
      // or a failure was expected, and an expected failure names its exact error.
      const fixtureFailure = bridge.failure();
      if (fixtureFailure) failures.push(`${label}: fixture failure ${fixtureFailure}`);
      if (expected.ok === false && !expected.error) failures.push(`${label}: an expected failure needs expect.error`);
      if (!outcome.ok && !(expected.ok === false && expected.error === outcome.error))
        failures.push(`${label}: failed with ${outcome.error}`);
      if (expected.ok !== undefined && expected.ok !== outcome.ok) failures.push(`${label}: ok ${outcome.ok} (${outcome.error})`);
      if (expected.error !== undefined && expected.error !== outcome.error) failures.push(`${label}: error ${outcome.error}`);
      if (expected.value !== undefined && JSON.stringify(expected.value) !== JSON.stringify(outcome.value))
        failures.push(`${label}: value ${JSON.stringify(outcome.value)}`);
      if (expected.calls) {
        if (expected.calls.length !== calls.length)
          failures.push(`${label}: ${calls.length} calls ${JSON.stringify(calls.map((c) => c.operation))}`);
        for (const [position, call] of expected.calls.entries())
          for (const [field, value] of Object.entries(call))
            if (JSON.stringify(value) !== JSON.stringify((calls[position] as Record<string, unknown> | undefined)?.[field]))
              failures.push(
                `${label}: call ${position + 1} ${field} is ${JSON.stringify((calls[position] as Record<string, unknown> | undefined)?.[field])}`,
              );
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
      const request = {
        method: "GET",
        path: entry.route.path,
        query: "",
        params: {},
        contentType: "text/plain",
        body: "",
        user: { id: "u1", username: "visitor", groupIds: [], groupNames: [], kind: "user", name: "Visitor" },
      };
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
    if (words[said] !== unattended(capability))
      wrong.push(`${capability}: the table says "${said}", the SDK and Admin preset give ${unattended(capability)}`);
  // Every Action of the documented apps, including those the SDK omits (streams, code: false).
  for (const manifest of manifests)
    for (const action of manifest.actions) {
      const capability = `${manifest.appId}.${action.localId}`;
      const documented = manifest.appId === "core" ? capability.startsWith("core.ai.") : !["imports", "grids"].includes(manifest.appId);
      if (documented && !listed.has(capability)) wrong.push(`${capability}: Action missing from the capability tables`);
    }
  expect(wrong).toEqual([]);
});
