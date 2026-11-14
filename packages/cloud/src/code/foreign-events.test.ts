import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { acceptanceChecker } from "../../../core/src/code/acceptance.test-fixture";
import { CapabilityManifestSchema } from "../contracts/capabilities";
import { generateCodeSdk } from "./generator";

// App manifests compile in their owning package so their @/ aliases retain the right scope.
const compile = Bun.spawnSync(
  [
    process.execPath,
    "-e",
    `
const { compileCapabilityManifest } = await import(${JSON.stringify(resolve(import.meta.dir, "../capabilities/testing.ts"))});
const manifests = [];
for (const [appId, name] of [["spaces", "spacesCapabilities"], ["notebooks", "notebooksCapabilities"], ["chat", "chatCapabilities"], ["contacts", "contactsCapabilities"], ["filesv2", "filesCapabilities"]]) {
  const definitions = await import(${JSON.stringify(resolve(import.meta.dir, "../../.."))} + "/" + appId + "/src/capabilities.ts");
  manifests.push(compileCapabilityManifest(appId, definitions[name]));
}
process.stdout.write(JSON.stringify(manifests));`,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
if (compile.exitCode !== 0) throw new Error(compile.stderr.toString());
const manifests = CapabilityManifestSchema.array().parse(JSON.parse(compile.stdout.toString()));
let checker: Awaited<ReturnType<typeof acceptanceChecker>>;
beforeAll(async () => {
  checker = await acceptanceChecker();
});
afterAll(async () => {
  await checker?.close();
});

test("real foreign Spaces and Notebooks handlers check and run, and their bundle rejects an undeclared place", async () => {
  for (const mode of [
    { mode: "personal" } as const,
    { mode: "resource", owner: { kind: "resource", ref: { type: "spaces.space", id: "owner" } } } as const,
  ]) {
    const sdk = generateCodeSdk(manifests, mode);
    const result = await checker.check({
      files: {
        "code.ts": `import { app, spaces, notebooks } from "@sdk";
app.on(spaces.space("Spc001"), "spaces.item.due", async event => { void event.subject.id; });
app.on(spaces.space("Spc002"), "spaces.item.due", async event => { void event.subject.id; });
app.on(notebooks.notebook("Ntb001"), "notebooks.note.created", async event => { void event.subject.id; });
export default app;`,
      },
      entry: "code.ts",
      sdk,
      aiOperations: [],
    });
    expect(result.diagnostics).toEqual([]);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.manifest.entrypoints.map((entry) => entry.event)).toEqual([
      { type: "spaces.item.due", version: 1, place: { type: "spaces.space", id: "Spc001" } },
      { type: "spaces.item.due", version: 1, place: { type: "spaces.space", id: "Spc002" } },
      { type: "notebooks.note.created", version: 1, place: { type: "notebooks.notebook", id: "Ntb001" } },
    ]);
    for (const entry of result.manifest.entrypoints) {
      const invoke = async (place = entry.event!.place) => {
        const module = await import(
          `data:text/javascript;base64,${Buffer.from(result.bundle + "\n// " + mode.mode + entry.entrypoint + place.id).toString("base64")}`
        );
        return module[entry.entrypoint](
          {
            id: "00000000-0000-4000-8000-000000000001",
            type: entry.event!.type,
            version: 1,
            source: place.type.split(".")[0],
            time: "2026-11-01T00:00:00Z",
            subject: { type: "spaces.item", id: "item" },
            place,
            data: {},
          },
          {
            call: async () => {
              throw new Error("unexpected call");
            },
          },
        );
      };
      await expect(invoke()).resolves.toBeUndefined();
      await expect(invoke({ ...entry.event!.place, id: "undeclared" })).rejects.toThrow("code_event_input");
    }
  }
}, 60_000);

test("every real app event place exposes the generic read-access contract", () => {
  for (const manifest of manifests) {
    for (const event of manifest.events ?? []) {
      if (!event.place) continue;
      expect(manifest.resourceTypes?.find((type) => type.type === event.place)?.readable).toBe(true);
      expect(manifest.queries.find((query) => query.localId === `${event.place}.readable`)?.appOnly).toBe(true);
    }
  }
});
