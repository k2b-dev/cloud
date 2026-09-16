import { expect, test } from "bun:test";
import { sourceDiagnostics } from "./source";
import { CODE_SOURCE_TOOLS } from "@k2b/cloud/ai";
import { artifactCodeHandlers } from "./code-tools";

test("direct source tools require revisions for atomic writes", () => {
  expect(Object.keys(artifactCodeHandlers).sort()).toEqual(Object.keys(CODE_SOURCE_TOOLS).sort());
  expect(CODE_SOURCE_TOOLS.code_write.input.parse({ id: "aBc234", expectedRevision: 1, files: [{ path: "main.ts", content: "export default !!!" }] })).toBeDefined();
});

test("missing helpers and invalid intermediate code produce diagnostics", async () => {
  expect((await sourceDiagnostics({ entry: "main.ts", files: [] })).length).toBeGreaterThan(0);
  const errors = await sourceDiagnostics({ entry: "main.ts", files: [{ path: "main.ts", content: "export default !!!" }] });
  expect(errors.join(" ")).toContain("main.ts");
  expect(errors.join(" ")).not.toBe("Bundle failed");
  expect(await sourceDiagnostics({ entry: "main.ts", files: [{ path: "main.ts", content: "export default () => 42" }] })).toEqual([]);
});
