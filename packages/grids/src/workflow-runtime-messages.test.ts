import { describe, expect, test } from "bun:test";
import type { WorkflowActionContext } from "@valentinkolb/cloud/workflows";
import { workflowInvocationLocale, workflowRuntimeMessages, workflowRuntimeText } from "./workflow-runtime-messages";
import { GRIDS_WORKFLOW_ACTIONS } from "./workflows";

const actionContext = (locale: string): WorkflowActionContext => ({
  runId: "run-1",
  stepKey: "request",
  invocation: {
    workflowId: "workflow-1",
    mode: "execute",
    channel: "api",
    actor: {},
    inputs: {},
    idempotencyKey: "invocation-1",
    occurredAt: "2026-08-29T10:00:00.000Z",
    context: { locale },
  },
  binding: () => undefined,
  resolveReference: async () => undefined,
  variableSnapshot: () => ({}),
  effectKey: "effect-1",
  heartbeat: async () => {},
});

describe("workflow runtime messages", () => {
  test("keeps the English and German catalogs complete", () => {
    const english = workflowRuntimeMessages.resolve(["en"]).t;
    const german = workflowRuntimeMessages.resolve(["de"]).t;

    expect(Object.keys(german).sort()).toEqual(Object.keys(english).sort());
  });

  test("resolves regional German locales without changing technical values", () => {
    const t = workflowRuntimeText("de-CH");

    expect(t.finalizationModeRequired).toContain("direct oder fourEyes");
    expect(t.stableBindingMissing({ path: "changes.2.updateRecord.set.total" })).toContain("changes.2.updateRecord.set.total");
    expect(t.httpFailed({ status: 503 })).toBe("httpRequest hat HTTP 503 zurückgegeben");
    expect(t.updateFields({ count: 1 })).toBe("Ein Feld in einem Datensatz aktualisieren");
    expect(t.updateFields({ count: 2 })).toBe("2 Felder in einem Datensatz aktualisieren");
  });

  test("uses the immutable invocation context locale", () => {
    expect(workflowInvocationLocale({ locale: "de-CH" })).toBe("de-CH");
    expect(workflowRuntimeText(workflowInvocationLocale({ locale: "de-CH" })).httpOutcomeUnknown).toBe(
      "Ein vorheriger HTTP-Versuch hat den entfernten Dienst möglicherweise erreicht und wird nicht automatisch wiederholt.",
    );
    expect(workflowRuntimeText(workflowInvocationLocale({ locale: "en" })).httpOutcomeUnknown).toBe(
      "A previous HTTP attempt may have reached the remote service; it is not repeated automatically.",
    );
  });

  test("stores the invocation language in ambiguous HTTP outcomes", async () => {
    const reconcile = GRIDS_WORKFLOW_ACTIONS.httpRequest.reconcile;
    if (!reconcile) throw new Error("httpRequest reconcile hook is missing");

    await expect(reconcile(actionContext("de-CH"), "effect-1")).resolves.toEqual({
      state: "unknown",
      code: "WORKFLOW_HTTP_OUTCOME_UNKNOWN",
      message: "Ein vorheriger HTTP-Versuch hat den entfernten Dienst möglicherweise erreicht und wird nicht automatisch wiederholt.",
    });
  });
});
