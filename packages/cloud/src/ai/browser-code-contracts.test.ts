import { expect, test } from "bun:test";
import { CODE_RUNTIME_TOOL_NAMES, parseCodeToolInput } from "./browser-code-contracts";

const id = "aBc234";
test("code_interact and node inspection no longer exist", () => {
  expect(() => parseCodeToolInput("code_interact", { runId: "run", id: "count" })).toThrow();
  expect(() => parseCodeToolInput("code_inspect", { runId: "run", nodeId: "table" })).toThrow();
});
test("code tools accept flat arguments and reject legacy envelopes", () => {
  const inputs = [
    { code: "export default () => 1" },
    { runId: "run" },
    { runId: "run" },
    { runId: "run", name: "report.csv" },
    { name: "crm", origin: "https://api.example.com" },
  ];
  for (const [index, name] of CODE_RUNTIME_TOOL_NAMES.entries()) {
    expect(String(parseCodeToolInput(name, inputs[index]).operation)).toEqual(name.slice(5));
    expect(() => parseCodeToolInput(name, { ...inputs[index], operation: name.slice(5) })).toThrow();
  }
  expect(() => parseCodeToolInput("code_run", { id, revision: 1 })).toThrow();
  expect(() => parseCodeToolInput("browser_code", { operation: "run", id })).toThrow();
});

test("one-off scripts require inline code and reject retired saved-app contexts", () => {
  expect(parseCodeToolInput("code_run", { code: "export default () => 42" })).toMatchObject({ operation: "run", inputPaths: [] });
  expect(() => parseCodeToolInput("code_run", { id, version: 2 })).toThrow();
  expect(() => parseCodeToolInput("code_run", { id, code: "export default () => 42" })).toThrow();
  expect(() => parseCodeToolInput("code_run", { code: "export default () => 42", version: 2 })).toThrow();
  expect(() => parseCodeToolInput("code_run", {})).toThrow();
});

test("retired Studio tools and resource contexts cannot execute", () => {
  for (const name of ["code_action", "code_open", "code_present", "code_check"]) {
    expect(CODE_RUNTIME_TOOL_NAMES).not.toContain(name);
    expect(() => parseCodeToolInput(name, { id })).toThrow();
  }
  expect(() => parseCodeToolInput("code_run", { code: "export default () => 1", resourceId: id })).toThrow();
  expect(() => parseCodeToolInput("code_secret", { name: "crm", origin: "https://example.com", resourceId: id })).toThrow();
});

test("code_secret keeps legacy names/defaults and validates automation identifiers, bindings and empty prefix", () => {
  const legacy = parseCodeToolInput("code_secret", { name: "my-key", origin: "https://example.com", header: "Authorization" });
  expect(legacy).toMatchObject({ name: "my-key", header: "Authorization", prefix: "Bearer " });
  const input = {
    name: "_API",
    origin: "https://example.com",
    header: "Authorization",
    prefix: "",
    target: { code: id, pathPrefix: "/v1" },
  };
  expect(parseCodeToolInput("code_secret", input)).toMatchObject({ header: "authorization", target: input.target });
  for (const patch of [
    { name: "my-key" },
    { name: "a".repeat(65) },
    { name: "äpi" },
    { prefix: "Bearer " },
    { prefix: undefined },
    { header: "cookie" },
    { header: "host" },
    { header: "a\nb" },
    { origin: "http://example.com" },
    { origin: "https://example.com/path" },
    { target: { code: id, pathPrefix: "/v1/../admin" } },
    { target: { code: id, pathPrefix: "/v1%2f" } },
    { target: { code: "not-a-code", pathPrefix: "/" } },
    { target: { code: id, pathPrefix: "/", value: "never-here" } },
    { value: "never-here" },
  ])
    expect(() => parseCodeToolInput("code_secret", { ...input, ...patch })).toThrow();
  expect(() => parseCodeToolInput("code_secret", { name: "_API", origin: "https://example.com" })).toThrow();
});
