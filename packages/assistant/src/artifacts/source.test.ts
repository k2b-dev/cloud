import { expect, test } from "bun:test";
import { sourceDiagnostics } from "./source";
import { artifactCapabilities } from "./capabilities";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";

test("file tools compile through discovery without legacy operations or required revisions", () => {
  const manifest = compileCapabilityManifest("assistant", artifactCapabilities);
  expect(manifest.actions.every(action => action.approval === "none")).toBe(true);
  expect(Object.keys(artifactCapabilities.actions)).toEqual(["code_create", "code_write", "code_remove"]);
  expect(Object.keys(artifactCapabilities.queries)).toEqual(["code_list", "code_read", "code_history"]);
  expect(artifactCapabilities.actions.code_write.input.parse({ id: "00000000-0000-4000-8000-000000000001", path: "main.ts", content: "export default !!!" })).toBeDefined();
});

test("missing helpers and invalid intermediate code produce diagnostics", async () => {
  expect((await sourceDiagnostics({ entry: "main.ts", files: [] })).length).toBeGreaterThan(0);
  const errors = await sourceDiagnostics({ entry: "main.ts", files: [{ path: "main.ts", content: "export default !!!" }] });
  expect(errors.join(" ")).toContain("main.ts");
  expect(errors.join(" ")).not.toBe("Bundle failed");
  expect(await sourceDiagnostics({ entry: "main.ts", files: [{ path: "main.ts", content: "export default () => 42" }] })).toEqual([]);
});
