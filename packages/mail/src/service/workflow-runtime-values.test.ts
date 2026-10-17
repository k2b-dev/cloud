import { describe, expect, spyOn, test } from "bun:test";
import type { WorkflowBoundPlan, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { readWorkflowValuePath } from "@k2b/cloud/workflows/language";
import { sql } from "bun";
import { MAIL_WORKFLOW_ACTIONS } from "../workflows/actions";
import * as publicResources from "./public-resources";
import {
  createMailWorkflowValueResolver,
  normalizeMailWorkflowFrozenHydration,
  projectMailWorkflowFrozenBody,
} from "./workflow-runtime-values";

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
  normalizeMailWorkflowFrozenHydration(frozenHydration);
  projectMailWorkflowFrozenBody("message", message, frozenHydration);
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

describe("Mail frozen body projection", () => {
  test.each(["both", "plain", "html", "empty"])("projects %s frozen bodies in place", (scenario) => {
    const message = { body: "", bodyText: "", bodyHtml: "", bodyAvailable: false, flags: ["seen"] };
    const inputs = { message, alias: message };
    const frozen: Record<string, WorkflowJsonValue> = {};
    if (scenario === "both" || scenario === "plain") frozen["inputs.message.bodyText"] = "Frozen text";
    if (scenario === "both" || scenario === "html") frozen["inputs.message.bodyHtml"] = "<p>Frozen HTML</p>";

    projectMailWorkflowFrozenBody("message", inputs.message, frozen);

    expect(inputs.message).toBe(message);
    expect(inputs.alias).toBe(message);
    expect(message).toEqual({
      body: scenario === "both" || scenario === "plain" ? "Frozen text" : "",
      bodyText: scenario === "both" || scenario === "plain" ? "Frozen text" : "",
      bodyHtml: scenario === "both" || scenario === "html" ? "<p>Frozen HTML</p>" : "",
      bodyAvailable: scenario === "both",
      flags: ["seen"],
    });
  });

  test("normalizes legacy text before projection without replacing the canonical key", () => {
    const frozen = {
      "inputs.legacy.body": "Legacy text",
      "inputs.legacy.bodyHtml": "",
      "inputs.current.body": "Superseded text",
      "inputs.current.bodyText": "",
      "inputs.current.bodyHtml": "",
    };
    normalizeMailWorkflowFrozenHydration(frozen);
    for (const name of ["legacy", "current"]) {
      const message = { body: "", bodyText: "", bodyHtml: "", bodyAvailable: false };
      projectMailWorkflowFrozenBody(name, message, frozen);
      expect(message).toEqual({
        body: name === "legacy" ? "Legacy text" : "",
        bodyText: name === "legacy" ? "Legacy text" : "",
        bodyHtml: "",
        bodyAvailable: true,
      });
    }
  });

  test("leaves available old-event bodies untouched", () => {
    const message = { body: "Old text", bodyText: "Old text", bodyHtml: "<p>Old HTML</p>", bodyAvailable: true };
    const before = { ...message };
    projectMailWorkflowFrozenBody("message", message, { "inputs.message.bodyText": "New text", "inputs.message.bodyHtml": "New HTML" });
    expect(message).toEqual(before);
  });

  test("ignores non-object message inputs", () => {
    for (const message of [undefined, null, "message", []]) {
      expect(() => projectMailWorkflowFrozenBody("message", message, { "inputs.message.bodyText": "Frozen text" })).not.toThrow();
    }
  });
});

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

  test("reuses plain text frozen before #1313 without reading Mail or freezing again", async () => {
    const read = spyOn(publicResources, "resolveMailboxPublicId").mockImplementation(async () => {
      throw new Error("Legacy frozen bodies must not read Mail");
    });
    const freeze = spyOn(sql, "begin").mockImplementation(() => {
      throw new Error("Legacy frozen bodies must not write a database freeze");
    });
    try {
      const frozen: Record<string, WorkflowJsonValue> = { "inputs.message.body": "Legacy frozen text" };
      const { message, resolve } = fixture(frozen);
      expect(await resolve("inputs.message.bodyText")).toEqual({ state: "resolved", value: "Legacy frozen text" });
      expect(await resolve("inputs.message.body")).toEqual({ state: "resolved", value: "Legacy frozen text" });
      expect(message).toMatchObject({ body: "Legacy frozen text", bodyText: "Legacy frozen text", bodyAvailable: false });
      expect(frozen).toEqual({ "inputs.message.body": "Legacy frozen text", "inputs.message.bodyText": "Legacy frozen text" });
      expect(read).not.toHaveBeenCalled();
      expect(freeze).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      freeze.mockRestore();
    }
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

  test("Mail reference-only message fields reuse eager frozen bodies without reading Mail", async () => {
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
        expect(message).toMatchObject({
          body: "Frozen plain text",
          bodyText: "Frozen plain text",
          bodyHtml: "<p>Frozen HTML</p>",
          bodyAvailable: true,
        });
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

  test("whole message values retain frozen plain text when HTML is unavailable", async () => {
    const read = spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(null);
    try {
      const { message, resolve } = fixture({ "inputs.message.bodyText": "Frozen plain text" });
      expect(await resolve("inputs.message", ["steps", 0, "setVariable", "value"])).toEqual({ state: "resolved", value: message });
      expect(message).toMatchObject({
        body: "Frozen plain text",
        bodyText: "Frozen plain text",
        bodyHtml: "",
        bodyAvailable: false,
      });
      expect(read).toHaveBeenCalledTimes(1);
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
