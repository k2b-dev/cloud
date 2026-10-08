import { expect, test } from "bun:test";
import { CODE_RUNTIME_TOOL_NAMES, parseCodeToolInput } from "./browser-code-contracts";

const id = "aBc234";
test("code_interact and node inspection no longer exist", () => {
  expect(() => parseCodeToolInput("code_interact", { runId: "run", id: "count" })).toThrow();
  expect(() => parseCodeToolInput("code_inspect", { runId: "run", nodeId: "table" })).toThrow();
});
test("code tools accept flat arguments and reject legacy envelopes", () => {
  const inputs = [
    { id },
    { id, action: "double", publishedVersion: 1, input: { value: 2 } },
    { runId: "run" },
    { runId: "run" },
    { id },
    { runId: "run", name: "report.csv" },
    { id },
    { name: "crm", origin: "https://api.example.com" },
  ];
  for (const [index, name] of CODE_RUNTIME_TOOL_NAMES.entries()) {
    expect(String(parseCodeToolInput(name, inputs[index]).operation)).toEqual(name.slice(5));
    expect(() => parseCodeToolInput(name, { ...inputs[index], operation: name.slice(5) })).toThrow();
  }
  expect(() => parseCodeToolInput("code_run", { id, revision: 1 })).toThrow();
  expect(() => parseCodeToolInput("browser_code", { operation: "run", id })).toThrow();
});

test("one-off scripts need no resource while historical runs require one", () => {
  expect(parseCodeToolInput("code_run", { code: "export default () => 42" })).toMatchObject({ operation: "run", inputPaths: [] });
  expect(parseCodeToolInput("code_run", { id, version: 2 })).toMatchObject({ operation: "run", id, version: 2 });
  expect(() => parseCodeToolInput("code_run", { id, code: "export default () => 42" })).toThrow();
  expect(() => parseCodeToolInput("code_run", { code: "export default () => 42", version: 2 })).toThrow();
  expect(() => parseCodeToolInput("code_run", {})).toThrow();
});

test("one-off resource context cannot replace saved source identity", () => {
  const resourceId = "aBc234";
  expect(parseCodeToolInput("code_run", { code: "export default () => 1", resourceId })).toMatchObject({ resourceId });
  expect(() => parseCodeToolInput("code_run", { id: resourceId, resourceId })).toThrow();
  expect(() => parseCodeToolInput("code_run", { resourceId })).toThrow();
});

test("action input is an object, never JSON text", () => {
  const call = { id, action: "double", publishedVersion: 1 };
  expect(parseCodeToolInput("code_action", call)).toMatchObject({ input: {} });
  expect(parseCodeToolInput("code_action", { ...call, input: { value: 2 } })).toMatchObject({ input: { value: 2 } });
  for (const input of ["{}", '{"value":2}', 2, [2], null]) expect(() => parseCodeToolInput("code_action", { ...call, input })).toThrow();
});

test("code_present takes a saved app or one-off files with index.html", () => {
  expect(parseCodeToolInput("code_present", { id })).toMatchObject({ operation: "present", id });
  const files = [{ path: "index.html", content: "<h1>Hi</h1>" }];
  expect(parseCodeToolInput("code_present", { files, title: "Overview" })).toMatchObject({ operation: "present", files });
  expect(() => parseCodeToolInput("code_present", { files })).toThrow();
  expect(() => parseCodeToolInput("code_present", { id, files, title: "Overview" })).toThrow();
  expect(() => parseCodeToolInput("code_present", { files: [{ path: "app.js", content: "" }], title: "Overview" })).toThrow();
  expect(() => parseCodeToolInput("code_present", { files: [{ path: "../index.html", content: "" }], title: "Overview" })).toThrow();
  expect(() => parseCodeToolInput("code_present", { runId: "run", title: "Overview" })).toThrow();
});
