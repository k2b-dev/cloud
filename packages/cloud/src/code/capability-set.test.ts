import { expect, test } from "bun:test";
import type { NormalizedCapabilityCall } from "../contracts/capabilities";
import type { CodeVersionPermission } from "../contracts/code-version";
import { CodeBridgeRefusal } from "./bridge-contract";
import { requireCodeCapabilityDeclared } from "./capability-set";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";
import type { CodeSdkBridge } from "./types";

const row = (operation: string, target: CodeVersionPermission["target"]): CodeVersionPermission => ({
  operation,
  target,
  file: "main.ts",
  line: 1,
});
const call = (changes: Partial<NormalizedCapabilityCall> = {}): NormalizedCapabilityCall => ({
  capability: "demo.move",
  target: { type: "demo.folder", id: "Folder001" },
  refs: { destination: { type: "demo.folder", id: "Folder002" } },
  input: {},
  ...changes,
});
test("declared capability admission checks the actual operation and every target and ref", () => {
  const declared = [row("demo.move", call().target), row("demo.move", call().refs.destination!)];
  expect(() => requireCodeCapabilityDeclared(call(), declared)).not.toThrow();
  for (const actual of [
    call({ capability: "demo.other" }),
    call({ target: null }),
    call({ target: { type: "demo.folder", id: "Folder003" } }),
    call({ target: { type: "other.folder", id: "Folder001" } }),
    call({ refs: { destination: { type: "demo.folder", id: "Folder003" } } }),
    call({ refs: { destination: { type: "other.folder", id: "Folder002" } } }),
  ]) {
    try {
      requireCodeCapabilityDeclared(actual, declared);
      throw new Error("Unexpected admission");
    } catch (error) {
      expect(error).toBeInstanceOf(CodeBridgeRefusal);
      expect(error).toMatchObject({ code: "code_capability_undeclared", status: 403 });
    }
  }
  expect(() => requireCodeCapabilityDeclared(call(), [])).toThrow("code_capability_undeclared");
});

test("dynamic evidence accepts only its declared Type in every Code mode", () => {
  const declared = [row("demo.move", { type: "demo.folder", id: null })];
  expect(() => requireCodeCapabilityDeclared(call(), declared)).not.toThrow();
  expect(() => requireCodeCapabilityDeclared(call({ target: { type: "other.folder", id: "Folder001" } }), declared)).toThrow(
    "code_capability_undeclared",
  );
  expect(() => requireCodeCapabilityDeclared(call({ target: null }), declared)).toThrow("code_capability_undeclared");
});

test("an executable SDK call is bounded by its version evidence independently of checker attribution", async () => {
  const fixture = sdkFixture("core");
  const sdk = generateCodeSdk(
    [
      {
        ...fixture,
        queries: [...fixture.queries, { ...fixture.queries.find((op) => op.localId === "catalog.list")!, localId: "ai.generate" }],
      },
    ],
    { mode: "personal" },
  );
  const loaded: {
    core: Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
    __codeSdk: { bind(bridge: CodeSdkBridge): void };
  } = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  let dispatched = 0;
  const evidence = [row("core.catalog.list", null)];
  loaded.__codeSdk.bind({
    async call(_operation, invocation) {
      if (!("call" in invocation)) throw new Error("Unexpected HTTP call");
      requireCodeCapabilityDeclared(invocation.call, evidence);
      dispatched++;
      return { data: [] };
    },
  });
  const ns = JSON.parse('"ai"');
  const method = JSON.parse('"generate"');
  await expect(loaded.core[ns]![method]!({})).rejects.toMatchObject({ code: "code_capability_undeclared", status: 403 });
  expect(dispatched).toBe(0);
  await loaded.core.catalog!.list!({});
  expect(dispatched).toBe(1);
  // AI tools invoke the same SDK function through a callback. That never widens
  // the run's declared set, even if a checker admits the function as a value.
  const tools = [loaded.core.ai!.generate!];
  await expect(tools[0]!({})).rejects.toMatchObject({ code: "code_capability_undeclared" });
  expect(dispatched).toBe(1);
  evidence.push(row("core.ai.generate", null));
  await tools[0]!({});
  expect(dispatched).toBe(2);
});
