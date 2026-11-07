import { describe, expect, test } from "bun:test";
import type { WorkflowRunSummary } from "@k2b/cloud/workflows/store";
import { projectMailBackfillActivity, projectMailWorkflowActivity, summarizeMailAutomationActivity } from "./automation-activity";
import type { IncomingAutomationBackfillActivity } from "./incoming-automations";

const run = (workflowId: string, state: WorkflowRunSummary["state"] = "succeeded"): WorkflowRunSummary => ({
  id: `run-${workflowId}`,
  appId: "mail",
  scopeId: "mailbox-1",
  workflowId,
  workflowName: `Workflow ${workflowId}`,
  revision: 1,
  mode: "execute",
  state,
  attempt: 1,
  eventType: "mail.message.received",
  parentRunId: null,
  occurredAt: new Date("2026-07-28T10:00:00.000Z"),
  createdAt: new Date("2026-07-28T10:00:01.000Z"),
  startedAt: new Date("2026-07-28T10:00:01.100Z"),
  finishedAt: new Date("2026-07-28T10:00:01.200Z"),
  startLagMs: 100,
  durationMs: 100,
  error: null,
  resultMessage: null,
});

const backfill = (overrides: Partial<IncomingAutomationBackfillActivity> = {}): IncomingAutomationBackfillActivity => ({
  operationId: "operation-1",
  automationId: "automation-1",
  workflowId: "workflow-1",
  name: "Invoices",
  status: "completed",
  dispatched: 3,
  lastError: null,
  createdAt: "2026-07-28T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:02.000Z",
  ...overrides,
});

describe("Mail automation activity projection", () => {
  test("distinguishes guided replies, incoming automations, and custom workflows", () => {
    const common = {
      mailboxId: "mailbox-1",
      replyWorkflowIds: new Set(["reply"]),
      incomingAutomationWorkflowIds: new Set(["automation"]),
      workflowNames: new Map([["automation", "Invoices"]]),
    };
    expect(projectMailWorkflowActivity({ ...common, run: run("reply") })).toMatchObject({
      kind: "automatic_reply",
      detail: "Received",
      href: "/app/mail/mailbox-1/automations/replies",
    });
    expect(projectMailWorkflowActivity({ ...common, run: run("automation") })).toMatchObject({
      kind: "incoming_automation",
      name: "Invoices",
      href: "/app/mail/mailbox-1/automations/incoming",
    });
    expect(projectMailWorkflowActivity({ ...common, run: run("custom") })).toMatchObject({
      kind: "workflow",
      href: "/app/mail/mailbox-1/automations/workflows",
    });
  });

  test("projects durable backfill progress and terminal states independently of traces", () => {
    expect(
      projectMailBackfillActivity({
        mailboxId: "mailbox-1",
        backfill: backfill(),
        automationNames: new Map([["automation-1", "Invoices"]]),
      }),
    ).toMatchObject({
      id: "backfill:automation-1:operation-1",
      kind: "backfill",
      name: "Backfill · Invoices",
      durationMs: 2_000,
      status: "completed",
      detail: "3 matching messages dispatched",
    });
    expect(
      projectMailBackfillActivity({
        mailboxId: "mailbox-1",
        backfill: backfill({ status: "failed", lastError: "Provider unavailable" }),
        automationNames: new Map(),
      }),
    ).toMatchObject({ status: "failed", detail: "Provider unavailable" });
    expect(
      projectMailBackfillActivity({
        mailboxId: "mailbox-1",
        backfill: backfill({ status: "canceled", dispatched: 1 }),
        automationNames: new Map(),
      }),
    ).toMatchObject({ status: "canceled" });
  });

  test("localizes generated backfill copy for regional German locales", () => {
    expect(
      projectMailBackfillActivity({
        mailboxId: "mailbox-1",
        backfill: backfill(),
        automationNames: new Map([["automation-1", "Rechnungen"]]),
        locale: "de-CH",
      }),
    ).toMatchObject({
      name: "Nachträgliche Verarbeitung · Rechnungen",
      detail: "3 passende E-Mails verarbeitet",
    });
  });

  test("keeps detailed errors and explains older broken conflict records", () => {
    const failed = run("rule", "failed");
    failed.error = { code: "CONFLICT", message: "The message changed before the action could be applied", retryable: false };
    expect(
      projectMailWorkflowActivity({
        mailboxId: "mailbox-1",
        run: failed,
        replyWorkflowIds: new Set(),
        incomingAutomationWorkflowIds: new Set(["rule"]),
      }),
    ).toMatchObject({ detail: "The message changed before the action could be applied" });

    failed.error = { code: "CONFLICT", message: "[object Object]", retryable: false };
    expect(
      projectMailWorkflowActivity({
        mailboxId: "mailbox-1",
        run: failed,
        replyWorkflowIds: new Set(),
        incomingAutomationWorkflowIds: new Set(["rule"]),
      }),
    ).toMatchObject({ detail: "Another change prevented this automation from applying its action." });
  });

  test("summarizes active and actionable entries", () => {
    const common = {
      mailboxId: "mailbox-1",
      replyWorkflowIds: new Set<string>(),
      incomingAutomationWorkflowIds: new Set<string>(),
    };
    const items = [
      projectMailWorkflowActivity({ ...common, run: run("one", "running") }),
      projectMailWorkflowActivity({ ...common, run: run("two", "failed") }),
      projectMailBackfillActivity({ mailboxId: "mailbox-1", backfill: backfill(), automationNames: new Map() }),
    ];
    expect(summarizeMailAutomationActivity(items)).toEqual({ total: 3, active: 1, failed: 1, backfills: 1 });
  });
});
