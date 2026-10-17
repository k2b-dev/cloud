import { describe, expect, spyOn, test } from "bun:test";
import type { WorkflowBoundPlan, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { readWorkflowValuePath } from "@k2b/cloud/workflows/language";
import { MAIL_WORKFLOW_ACTIONS } from "../workflows/actions";
import * as publicResources from "./public-resources";
import { createMailWorkflowValueResolver } from "./workflow-runtime-values";

const plan: WorkflowBoundPlan = {
  schemaVersion: 2,
  languageId: "mail",
  languageVersion: 1,
  sourceHash: "source",
  manifestHash: "manifest",
  catalogHash: "catalog",
  actionPolicies: {},
  inputs: [{ name: "message", type: "mailMessage", config: {} }],
  triggers: [],
  steps: [],
  bindings: {},
};

const fixture = (frozenHydration: Record<string, WorkflowJsonValue> = {}) => {
  const message = { id: "msg001", body: "", bodyText: "", bodyHtml: "", bodyAvailable: false, flags: ["seen"] };
  const inputs = { message };
  const resolver = createMailWorkflowValueResolver({
    claim: { runId: "run", executionGeneration: 1, inputs },
    mailboxId: "mailbox",
    frozenHydration,
    mailActionNames: new Set(Object.keys(MAIL_WORKFLOW_ACTIONS)),
  });
  return {
    message,
    inputs,
    resolve: (reference: string, path: Array<string | number> = []) =>
      resolver.resolve({
        reference,
        path,
        plan,
        invocation: {
          workflowId: "workflow",
          mode: "execute",
          channel: "event",
          actor: {},
          inputs,
          idempotencyKey: "fixture",
          occurredAt: "2026-10-01T08:00:00.000Z",
        },
        variables: { get: () => undefined, has: () => false, set: () => {} },
        fallback: () => readWorkflowValuePath({ inputs }, reference.split(".")),
      }),
  };
};

describe("Mail lazy workflow values", () => {
  test("body and bodyText share the plain frozen entry and update the shared projection", async () => {
    const frozen = { "inputs.message.bodyText": "Frozen plain text" };
    const { message, resolve } = fixture(frozen);
    // No id forces an old resolver using inputs.message.body to return missing instead of reading a database.
    Reflect.deleteProperty(message, "id");
    expect(await resolve("inputs.message.body")).toEqual({ state: "resolved", value: "Frozen plain text" });
    expect(await resolve("inputs.message.bodyText")).toEqual({ state: "resolved", value: "Frozen plain text" });
    expect(message).toMatchObject({ body: "Frozen plain text", bodyText: "Frozen plain text", bodyAvailable: false });
    expect(Object.keys(frozen)).toEqual(["inputs.message.bodyText"]);
  });

  for (const reference of ["inputs.message", "inputs"]) {
    test(`${reference} hydrates in place from frozen entries and preserves identity`, async () => {
      const { message, inputs, resolve } = fixture({
        "inputs.message.bodyText": "Frozen plain text",
        "inputs.message.bodyHtml": "<p>Frozen HTML</p>",
      });
      const alias = message;
      const outcome = await resolve(reference, ["steps", 0, "setVariable", "value"]);
      expect(outcome.state === "resolved" && outcome.value).toBe(reference === "inputs" ? inputs : message);
      expect(inputs.message).toBe(alias);
      expect(alias).toMatchObject({
        body: "Frozen plain text",
        bodyText: "Frozen plain text",
        bodyHtml: "<p>Frozen HTML</p>",
        bodyAvailable: true,
        flags: ["seen"],
      });
    });
  }

  test("Mail reference-only message fields do not read or project body content", async () => {
    const read = spyOn(publicResources, "resolveMailboxPublicId").mockImplementation(async () => {
      throw new Error("Reference-only fields must not read Mail");
    });
    try {
      for (const action of Object.keys(MAIL_WORKFLOW_ACTIONS)) {
        const { message, resolve } = fixture({
          "inputs.message.bodyText": "Frozen plain text",
          "inputs.message.bodyHtml": "<p>Frozen HTML</p>",
        });
        expect(await resolve("inputs.message", ["steps", 0, action, "message"])).toEqual({ state: "resolved", value: message });
        expect(message).toMatchObject({ body: "", bodyText: "", bodyHtml: "", bodyAvailable: false });
      }
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  test("unavailable bodies are missing while whole message values remain usable", async () => {
    const read = spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(null);
    try {
      const { message, resolve } = fixture();
      for (const field of ["body", "bodyText", "bodyHtml"]) {
        expect(await resolve(`inputs.message.${field}`)).toEqual({ state: "missing" });
      }
      expect(await resolve("inputs.message")).toEqual({ state: "resolved", value: message });
      expect(message.bodyAvailable).toBe(false);
    } finally {
      read.mockRestore();
    }
  });

  test("old events with available bodies retain their receipt-time values", async () => {
    const { message, resolve } = fixture({ "inputs.message.bodyText": "New frozen text" });
    Object.assign(message, { body: "Old plain text", bodyText: "Old plain text", bodyHtml: "<p>Old HTML</p>", bodyAvailable: true });
    expect(await resolve("inputs.message.body")).toEqual({ state: "resolved", value: "Old plain text" });
  });
});
