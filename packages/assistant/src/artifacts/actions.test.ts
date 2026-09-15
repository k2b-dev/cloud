import { expect, test } from "bun:test";
import { actionValidator, sourceActions } from "./actions";
import { compileArtifact, validateArtifact } from "./runtime/compile";
import type { ArtifactSource } from "./contracts";

const action = {
  name: "double", title: "Double a number", description: "Return twice the supplied number.", entry: "double.ts",
  inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false },
  outputSchema: { type: "number" },
};
const source = (actions: unknown[] = [action]): ArtifactSource => ({ entry: "main.ts", files: [
  { path: "app.actions.json", content: JSON.stringify({ actions }) },
  { path: "double.ts", content: "export default ({value}: {value:number}) => value * 2;" },
] });

test("discovery reads immutable metadata without evaluating handler source", () => {
  const input = source();
  input.files[1]!.content = 'throw new Error("must not run");';
  expect(sourceActions(input)).toEqual([action]);
  expect(sourceActions({ entry: "main.ts", files: [] })).toEqual([]);
});

test("actions require unique names, existing local handlers and supported schemas", () => {
  expect(() => sourceActions(source([action, action]))).toThrow("Duplicate");
  expect(() => sourceActions(source([{ ...action, entry: "missing.ts" }]))).toThrow("Missing");
  expect(() => sourceActions(source([{ ...action, entry: "../private.ts" }]))).toThrow();
  expect(() => sourceActions(source([{ ...action, dangerous: true }]))).toThrow();
  expect(() => actionValidator(action.inputSchema).parse({ value: "2" })).toThrow();
  expect(() => actionValidator(action.inputSchema).parse({ value: 2, extra: true })).toThrow();
  expect(actionValidator(action.outputSchema).parse(4)).toBe(4);
});

test("headless apps compile without a fake GUI entry, and actions use their own handler", async () => {
  await validateArtifact(source());
  expect((await compileArtifact(source())).code).toContain("null");
  const compiled = await compileArtifact(source(), { action: "double", input: { value: 2 } });
  expect(compiled.code).toContain("value");
  await expect(compileArtifact(source(), { action: "missing" })).rejects.toThrow("Unknown app action");
});

test("publication validates every handler, including code unused by the GUI", async () => {
  const input = source();
  input.files.push({ path: "main.ts", content: "export default () => 42;" });
  input.files[1]!.content = 'import secret from "bun"; export default () => secret;';
  await expect(validateArtifact(input)).rejects.toThrow("Only relative source imports");
});
