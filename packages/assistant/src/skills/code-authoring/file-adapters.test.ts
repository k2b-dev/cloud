import { afterEach, expect, setSystemTime, test } from "bun:test";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { generateCodeSdk } from "@k2b/cloud/code";
import { CapabilityManifestSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { compileScript } from "../../chat-code/runtime/compile";
import { createServiceCalls, type RuntimeSdkCallOptions } from "../../chat-code/runtime/services";

// Compile the current provider declarations in their own package contexts, just like examples.test.ts.
const packages = resolve(import.meta.dir, "../../../..");
const compile = Bun.spawnSync(
  [
    process.execPath,
    "-e",
    `
const {compileCapabilityManifest} = await import(${JSON.stringify(`${packages}/cloud/src/capabilities/testing.ts`)});
const providers = ${JSON.stringify([
      ["assistant", `${packages}/assistant/src/capabilities.ts`, "assistantCapabilities"],
      ["filesv2", `${packages}/filesv2/src/capabilities.ts`, "filesCapabilities"],
      ["mail", `${packages}/mail/src/capabilities.ts`, "mailCapabilities"],
    ])};
const manifests = [];
for (const [id,path,name] of providers) manifests.push(compileCapabilityManifest(id,(await import(path))[name]));
process.stdout.write(JSON.stringify(manifests));
`,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
if (compile.exitCode !== 0) throw new Error(compile.stderr.toString());
const manifests = z.array(CapabilityManifestSchema).parse(JSON.parse(compile.stdout.toString()));
const sdk = generateCodeSdk(manifests, { mode: "code_run" });
const docs = await Bun.file(resolve(packages, "../docs-site/docs/en/platform/code-sdk.md")).text();
const NOW = new Date("2026-11-11T10:00:00.000Z");
afterEach(() => setSystemTime());

for (const destination of ["files", "mail"] as const) {
  test(`the checked chat attachment example transfers unchanged bytes to the real ${destination} SDK Action`, async () => {
    setSystemTime(NOW);
    const capability = destination === "files" ? "filesv2.file.save.v1" : "mail.draft.attachment.import.v1";
    const operation = sdk.manifest.operations.find((op) => op.capability === capability);
    expect(operation?.stream?.direction).toBe("write");
    expect(operation?.idempotency).toBe("required");
    const source = docs.split(`<!-- chat-file-${destination}-example -->`)[1]?.split("```ts\n")[1]?.split("```")[0];
    if (!source) throw new Error("Missing checked example");
    const built = await compileScript({ entry: "example.ts", files: [{ path: "example.ts", content: source }] }, sdk, true);
    const bytes = new Uint8Array([0, 255, 10, 13]);
    const calls: { name: string; input: unknown; options?: RuntimeSdkCallOptions }[] = [];
    const expiry = new Date(NOW.getTime() + 60_000).toISOString();
    let written: Uint8Array | undefined;
    const receipt =
      destination === "files"
        ? { baseId: "base", entry: { name: "report.csv", size: bytes.length } }
        : { draftId: "Drf001", uploadId: "00000000-0000-4000-8000-000000000001", revision: 3 };
    const dispatch = createServiceCalls({
      capability: async (name, input, _signal, options) => {
        calls.push({ name, input, options });
        const definition = manifests
          .flatMap((manifest) => [...manifest.queries, ...manifest.actions].map((op) => ({ ...op, appId: manifest.appId })))
          .find((op) => `${op.appId}.${op.localId}` === name);
        if (!definition) throw new Error("Missing real provider schema");
        expect(z.fromJSONSchema(definition.inputSchema).safeParse(input).success).toBe(true);
        if (name !== "assistant.chat.file.read.v1" && name !== capability) throw new Error("Unexpected capability");
        const direction = name === capability ? "write" : "read";
        return {
          data: {},
          stream: {
            id: direction,
            callId: direction === "read" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002",
            direction,
            name: "report.csv",
            mediaType: "text/csv",
            size: bytes.length,
            expiresAt: expiry,
          },
        };
      },
      stream: async (stream, verb, body) => {
        if (verb === "read") return new File([bytes], "report.csv", { type: "text/csv", lastModified: NOW.getTime() });
        expect(stream.direction).toBe("write");
        if (!(body instanceof Blob)) throw new Error("Expected transferred bytes");
        written = new Uint8Array(await body.arrayBuffer());
        return { data: receipt };
      },
    });
    let entry: (() => Promise<unknown>) | undefined;
    const signal = new AbortController().signal;
    const context = createContext({
      __artifactStart: (run: () => Promise<unknown>) => {
        entry = run;
      },
      __artifactSdkStream: (name: string, input: unknown, options: unknown, direction: string) =>
        dispatch("capabilities.run", [name, input, options, direction], signal),
      cloud: {
        capabilities: {
          run: () => {
            throw new Error("Expected the file stream dispatcher");
          },
        },
      },
    });
    runInContext(built.code, context);
    if (!entry) throw new Error("No compiled entry");
    expect(await entry()).toEqual(receipt);
    expect(written).toEqual(bytes);
    expect(calls.map((call) => call.name)).toEqual(["assistant.chat.file.read.v1", capability]);
    expect(calls[1]?.input).toMatchObject({ file: { name: "report.csv", size: bytes.length, mediaType: "text/csv" } });
    expect(calls[1]?.input).not.toHaveProperty("file.id");
    expect(calls[1]?.options?.idempotencyKey).toBe(`${destination === "files" ? "save" : "attach"}-report:chat-one:revision-one`);
    expect(calls[1]?.options?.target).toEqual(
      destination === "mail" ? { type: "mail.mailbox", id: "Mbx001" } : { type: "filesv2.entry", id: "Root001" },
    );
  });
}
