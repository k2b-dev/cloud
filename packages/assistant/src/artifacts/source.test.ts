import { expect, test } from "bun:test";
import { sourceDiagnostics } from "./source";
import { CODE_SOURCE_TOOLS } from "@k2b/cloud/ai";
import { artifactCodeHandlers } from "./code-tools";

test("direct file tools have individual inputs without required revisions", () => {
  expect(Object.keys(artifactCodeHandlers)).toEqual(Object.keys(CODE_SOURCE_TOOLS));
  expect(CODE_SOURCE_TOOLS.code_write.input.parse({ id: "00000000-0000-4000-8000-000000000001", path: "main.ts", content: "export default !!!" })).toBeDefined();
});

test("missing helpers and invalid intermediate code produce diagnostics", async () => {
  expect((await sourceDiagnostics({ entry: "main.ts", files: [] })).length).toBeGreaterThan(0);
  const errors = await sourceDiagnostics({ entry: "main.ts", files: [{ path: "main.ts", content: "export default !!!" }] });
  expect(errors.join(" ")).toContain("main.ts");
  expect(errors.join(" ")).not.toBe("Bundle failed");
  expect(await sourceDiagnostics({ entry: "main.ts", files: [{ path: "main.ts", content: "export default () => 42" }] })).toEqual([]);
});
