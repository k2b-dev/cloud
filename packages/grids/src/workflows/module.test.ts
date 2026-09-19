import { describe, expect, test } from "bun:test";
import { defineWorkflowModule } from "@k2b/cloud/workflows";
import { compileWorkflow, hashWorkflowJson } from "@k2b/cloud/workflows/language";
import { gridsWorkflows } from "./module";

const gridsWorkflowManifest = gridsWorkflows.manifest;

describe("Grids workflow manifest", () => {
  test("client metadata matches executable action declarations", () => {
    expect(defineWorkflowModule({ ...gridsWorkflowManifest, actions: gridsWorkflows.actions }).manifest).toEqual(gridsWorkflowManifest);
  });

  test("is serializable and has unique vocabulary keys", () => {
    expect(JSON.parse(JSON.stringify(gridsWorkflowManifest))).toEqual(gridsWorkflowManifest);
    for (const descriptors of [gridsWorkflowManifest.inputs, gridsWorkflowManifest.triggers, gridsWorkflowManifest.actions]) {
      expect(new Set(descriptors.map((descriptor) => descriptor.kind)).size).toBe(descriptors.length);
    }
  });

  test("pins the current manifest hash; older plans require republication", async () => {
    expect(await hashWorkflowJson(gridsWorkflowManifest)).toBe("81c2e3fae6b76cb8dce99893c31b8fcc917242f454311c77f93586af2fbb5b82");
  });

  test("rejects removed actions at compilation", async () => {
    const result = await compileWorkflow("steps:\n  - parseDocument: {}\n", gridsWorkflows);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Removed action was accepted");
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "action.unknown" })]));
  });

  test("classifies every effectful action explicitly", () => {
    expect(Object.fromEntries(gridsWorkflowManifest.actions.map((action) => [action.kind, action.effect]))).toMatchObject({
      query: "transactional",
      finalizeRecord: "transactional",
      deleteRecord: "transactional",
      closeRecord: "transactional",
      createCorrectionDraft: "transactional",
      updateRecord: "transactional",
      createRecord: "transactional",
      atomicRecords: "transactional",
      generateDocument: "durable-intent",
      createDocumentLink: "transactional",
      sendEmail: "durable-intent",
      httpRequest: "ambiguous-external",
    });
  });

  test("exposes query outputs and record templates without a second batch action", () => {
    const action = gridsWorkflowManifest.actions.find((candidate) => candidate.kind === "generateDocument");

    expect(action?.config.kind).toBe("object");
    if (action?.config.kind !== "object") throw new Error("generateDocument config is not an object");
    expect(action.config.properties).not.toHaveProperty("batch");
    expect(action.config.properties).toHaveProperty("data");
    expect(action.config.properties).toHaveProperty("output");
  });
});
