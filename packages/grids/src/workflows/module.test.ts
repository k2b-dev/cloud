import { describe, expect, test } from "bun:test";
import { defineWorkflowModule } from "@k2b/cloud/workflows";
import { hashWorkflowJson } from "@k2b/cloud/workflows/language";
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

  test("pins the query-enabled manifest hash; older plans require republication", async () => {
    expect(await hashWorkflowJson(gridsWorkflowManifest)).toBe("c2c315518060ff185daaaf7a40cf0deaad1862914a1f459b93e08bcebce7b60c");
  });

  test("classifies every effectful action explicitly", () => {
    expect(Object.fromEntries(gridsWorkflowManifest.actions.map((action) => [action.kind, action.effect]))).toMatchObject({
      query: "transactional",
      finalizeRecord: "transactional",
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
