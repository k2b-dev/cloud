import { describe, expect, mock, test } from "bun:test";
import { sql } from "bun";
import { createWorkflowCaptureTableAccess, createWorkflowEffectAccess, type GridsWorkflowActionScope } from "./workflow-action-scope";

const scope = (app = true): GridsWorkflowActionScope => ({
  runId: "run",
  baseId: "base",
  workflow: { id: "workflow", shortId: "WF0001", name: "Workflow" },
  principal: { userId: "user", groupIds: [], serviceAccountId: null },
  launcherId: app ? "launcher" : null,
  authorization: app
    ? {
        kind: "custom-app-action",
        customAppId: "app",
        publishedAt: "2026-09-15T00:00:00Z",
        pageId: "page",
        pageParams: {},
        timeZone: "UTC",
        blockId: "actions",
        actionId: "run",
        revision: 1,
      }
    : { kind: "workflow" },
});

describe("atomic workflow effect access", () => {
  test("one execution decision covers repeated checks and a self-invalidating write, not a later effect", async () => {
    const deps = dependencies();
    const claim = scope();
    const access = await createWorkflowEffectAccess(claim, sql, deps);
    expect(access.scope).toBe(claim);
    for (let index = 0; index < 8; index++) await access.requireTable("source");
    // Availability was true under the locks. Our change can legitimately make
    // it false before document validation and other atomic postconditions.
    deps.canExecuteRun.mockResolvedValue(false);
    expect(await access.canReadTable("dependency")).toBe(true);
    await access.requireTable("source");
    expect(deps.canExecuteRun).toHaveBeenCalledTimes(1);
    expect(deps.workflowTableBelongsToBase).toHaveBeenCalledTimes(10);
    expect(deps.workflowTableBelongsToBase).toHaveBeenLastCalledWith("base", "source", sql);
    await expect(createWorkflowEffectAccess(claim, sql, deps)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deps.canExecuteRun).toHaveBeenCalledTimes(2);
  });

  test("write authority never grants another Base or a deleted table", async () => {
    const deps = dependencies();
    const access = await createWorkflowEffectAccess(scope(), sql, deps);
    expect(await access.canReadTable("foreign")).toBe(false);
    await expect(access.requireTable("foreign")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await access.requireTable("source");
    deps.workflowTableBelongsToBase.mockResolvedValue(false);
    expect(await access.canReadTable("source")).toBe(false);
    expect(deps.canExecuteRun).toHaveBeenCalledTimes(1);
  });

  test("direct effects require Base write including credential scope, not just read", async () => {
    const deps = dependencies();
    const claim = scope(false);
    deps.authorizeWorkflowBase.mockResolvedValue(false);
    await expect(createWorkflowEffectAccess(claim, sql, deps)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deps.authorizeWorkflowBase).toHaveBeenCalledWith(claim.principal, "base", "write", sql);
    expect(deps.canExecuteRun).not.toHaveBeenCalled();
    expect(deps.workflowTableBelongsToBase).not.toHaveBeenCalled();
  });

  test("a fresh post-lock decision rejects revocation instead of adopting an earlier check", async () => {
    const deps = dependencies();
    await createWorkflowCaptureTableAccess(scope(), sql, deps);
    deps.canExecuteRun.mockResolvedValue(false);
    await expect(createWorkflowEffectAccess(scope(), sql, deps)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deps.canExecuteRun).toHaveBeenCalledTimes(2);
    expect(deps.workflowTableBelongsToBase).not.toHaveBeenCalled();
  });
});

const dependencies = () => ({
  authorizeWorkflowBase: mock(async () => true),
  canExecuteRun: mock(async () => true),
  workflowTableBelongsToBase: mock(async (baseId: string, tableId: string) => baseId === "base" && tableId !== "foreign"),
});

describe("workflow query capture access", () => {
  test("checks the published execution once and every exact table in the capture client", async () => {
    const deps = dependencies();
    const claim = scope();
    const canRead = await createWorkflowCaptureTableAccess(claim, sql, deps);
    expect(await canRead("source")).toBe(true);
    expect(await canRead("historical-dependency")).toBe(true);
    expect(await canRead("foreign")).toBe(false);
    expect(deps.canExecuteRun).toHaveBeenCalledTimes(1);
    expect(deps.canExecuteRun).toHaveBeenCalledWith(claim, sql);
    expect(deps.authorizeWorkflowBase).not.toHaveBeenCalled();
    expect(deps.workflowTableBelongsToBase).toHaveBeenCalledTimes(3);
    expect(deps.workflowTableBelongsToBase).toHaveBeenCalledWith("base", "foreign", sql);
  });

  test("a new capture revalidates revocation instead of reusing the previous decision", async () => {
    const deps = dependencies();
    const claim = scope();
    const first = await createWorkflowCaptureTableAccess(claim, sql, deps);
    expect(await first("source")).toBe(true);
    deps.canExecuteRun.mockResolvedValue(false);
    const second = await createWorkflowCaptureTableAccess(claim, sql, deps);
    expect(await second("source")).toBe(false);
    expect(await second("historical-dependency")).toBe(false);
    expect(deps.canExecuteRun).toHaveBeenCalledTimes(2);
    expect(deps.workflowTableBelongsToBase).toHaveBeenCalledTimes(1);
  });

  test("direct workflows retain Base read grants and never use App execution as a substitute", async () => {
    const deps = dependencies();
    const claim = scope(false);
    deps.authorizeWorkflowBase.mockResolvedValue(false);
    const denied = await createWorkflowCaptureTableAccess(claim, sql, deps);
    expect(await denied("source")).toBe(false);
    expect(deps.authorizeWorkflowBase).toHaveBeenCalledWith(claim.principal, "base", "read", sql);
    expect(deps.workflowTableBelongsToBase).not.toHaveBeenCalled();
    deps.authorizeWorkflowBase.mockResolvedValue(true);
    const allowed = await createWorkflowCaptureTableAccess(claim, sql, deps);
    expect(await allowed("source")).toBe(true);
    expect(await allowed("foreign")).toBe(false);
    expect(deps.canExecuteRun).not.toHaveBeenCalled();
    expect(deps.authorizeWorkflowBase).toHaveBeenCalledTimes(2);
  });

  test("authorization and membership failures propagate without an allow fallback", async () => {
    const deps = dependencies();
    const failure = new Error("Authorization unavailable");
    deps.canExecuteRun.mockRejectedValueOnce(failure);
    await expect(createWorkflowCaptureTableAccess(scope(), sql, deps)).rejects.toBe(failure);
    expect(deps.workflowTableBelongsToBase).not.toHaveBeenCalled();
    const canRead = await createWorkflowCaptureTableAccess(scope(), sql, deps);
    deps.workflowTableBelongsToBase.mockRejectedValueOnce(failure);
    await expect(canRead("source")).rejects.toBe(failure);
  });
});
