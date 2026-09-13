import { expect, test } from "bun:test";
import { CODE_RUNTIME_TOOL_NAMES, parseCodeToolInput } from "./browser-code-contracts";

const id = "00000000-0000-4000-8000-000000000001";
test("code tools accept flat arguments and reject legacy envelopes", () => {
  const inputs = [{ id }, { runId: "run" }, { runId: "run", id: "@modal:1", value: { count: 2 } }, { runId: "run" }, { id }, { runId: "run", name: "report.csv" }];
  for (const [index, name] of CODE_RUNTIME_TOOL_NAMES.entries()) {
    expect(String(parseCodeToolInput(name, inputs[index]).operation)).toEqual(name.slice(5));
    expect(() => parseCodeToolInput(name, { ...inputs[index], operation: name.slice(5) })).toThrow();
  }
  expect(() => parseCodeToolInput("code_run", { id, revision: 1 })).toThrow();
  expect(() => parseCodeToolInput("browser_code", { operation: "run", id })).toThrow();
});

test("one-off scripts need no resource while historical runs require one", () => {
  expect(parseCodeToolInput("code_run", {code:"export default () => 42"})).toMatchObject({operation:"run",inputPaths:[]});
  expect(parseCodeToolInput("code_run", {id,version:2})).toMatchObject({operation:"run",id,version:2});
  expect(() => parseCodeToolInput("code_run", {id,code:"export default () => 42"})).toThrow();
  expect(() => parseCodeToolInput("code_run", {code:"export default () => 42",version:2})).toThrow();
  expect(() => parseCodeToolInput("code_run", {})).toThrow();
});

 test("one-off resource context cannot replace saved source identity", () => {
  const resourceId = "00000000-0000-4000-8000-000000000001";
  expect(parseCodeToolInput("code_run", { code: "export default () => 1", resourceId })).toMatchObject({ resourceId });
  expect(() => parseCodeToolInput("code_run", { id: resourceId, resourceId })).toThrow();
  expect(() => parseCodeToolInput("code_run", { resourceId })).toThrow();
});
