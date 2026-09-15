import { expect, test } from "bun:test";
import { CODE_RUNTIME_TOOL_NAMES, parseCodeToolInput } from "./browser-code-contracts";

const id = "aBc234";
test("interaction batches are bounded and cannot mix top-level actions", () => {
  expect(parseCodeToolInput("code_interact", {runId:"run",steps:[{id:"apply"},{id:"view",event:{type:"view",value:"table"}}]})).toMatchObject({steps:[{id:"apply"},{id:"view"}]});
  for (const input of [
    {runId:"run",steps:[]},
    {runId:"run",steps:Array.from({length:4},()=>({id:"apply"}))},
    {runId:"run",id:"apply",steps:[{id:"apply"}]},
    {runId:"run",steps:[{id:"apply",answer:null,event:{type:"refresh"}}]},
  ]) expect(() => parseCodeToolInput("code_interact",input)).toThrow();
});
test("UI interactions use structured events without legacy list action fields", () => {
  expect(parseCodeToolInput("code_interact", {runId:"run", id:"count", event:{type:"change",value:7}})).toMatchObject({event:{type:"change",value:7}});
  expect(() => parseCodeToolInput("code_interact", {runId:"run", id:"tasks", action:"delete",item:"one"})).toThrow();
  expect(() => parseCodeToolInput("code_interact", {runId:"run", id:"count", event:'{"type":"change","value":7}'})).toThrow();
  expect(() => parseCodeToolInput("code_interact", {runId:"run", id:"date", event:{type:"change",value:{start:"2026-01",end:"2026-08"}}})).toThrow();
  expect(() => parseCodeToolInput("code_interact", {runId:"run", id:"count", event:{type:"change",value:7}, answer:7})).toThrow();
  expect(parseCodeToolInput("code_interact", {runId:"run", id:"dialog", answer:"Example"})).toMatchObject({answer:"Example"});
});
test("code tools accept flat arguments and reject legacy envelopes", () => {
  const inputs = [{ id }, {id,action:"double",publishedVersion:1,input:2}, { runId: "run" }, { runId: "run", id: "@modal:1", answer: { count: 2 } }, { runId: "run" }, { id }, { runId: "run", name: "report.csv" }, {name:"crm",origin:"https://api.example.com"}];
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
  const resourceId = "aBc234";
  expect(parseCodeToolInput("code_run", { code: "export default () => 1", resourceId })).toMatchObject({ resourceId });
  expect(() => parseCodeToolInput("code_run", { id: resourceId, resourceId })).toThrow();
  expect(() => parseCodeToolInput("code_run", { resourceId })).toThrow();
});
