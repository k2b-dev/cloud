import { describe, expect, test } from "bun:test";
import { type CloudCliContext, type CloudCliFlags, defineCliCommands } from "@valentinkolb/cloud/cli";
import { compileWorkflow } from "@valentinkolb/cloud/workflows/language";
import { BulkLauncherRequestSchema } from "../api/workflow-public-contracts";
import { buildWorkflowCatalog } from "../service/workflow-catalog";
import { bindGridsWorkflow } from "../workflows/binder";
import { gridsWorkflows } from "../workflows/module";
import { workflowCommands, workflowRunCommands } from "./workflows";
import { WORKFLOW_REFERENCE, workflowRunRows, workflowStepRows } from "./workflows-support";

type FetchCall = { path: string; init?: RequestInit };

const baseId = "base1A";
const workflowId = "wf001A";
const launcherId = "ln001A";
const runId = "wrun01";
const itemRecordId = "item01";

const workflow = {
  id: workflowId,
  baseId,
  name: "Check in",
  description: null,
  source: "steps: []",
  enabled: true,
  position: 0,
  revision: 3,
  updatedAt: "2026-07-15T00:00:00.000Z",
};

const launcher = (kind: "scanner" | "bulk" | "record" | "customApp") => ({
  id: launcherId,
  baseId,
  workflowId,
  name: `${kind} launcher`,
  config:
    kind === "scanner"
      ? { kind, input: "item", resolve: { by: "scanCode" } }
      : kind === "bulk"
        ? { kind, input: "items" }
        : kind === "record"
          ? { kind, input: "original", profile: "correctionDraft" }
          : { kind, label: "Run" },
  enabled: true,
  validatedRevision: 3,
  diagnostics: [],
  deletedAt: null,
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
});

const receipt = {
  runId,
  workflowId,
  revision: 3,
  mode: "execute",
  channel: "api",
  created: true,
  status: "queued",
};

const revision = (number: number) => ({
  workflowId,
  revision: number,
  name: `Check in revision ${number}`,
  description: null,
  source: `steps:\n  - succeed:\n      message: "revision ${number}"`,
  position: 0,
  actorUserId: null,
  createdAt: `2026-07-${String(10 + number).padStart(2, "0")}T00:00:00.000Z`,
});

const jsonResponse = (value: unknown, status = 200) => Response.json(value, { status });

const createContext = (args: string[], flags: CloudCliFlags = {}, responses: Response[] = []) => {
  const calls: FetchCall[] = [];
  const lines: string[] = [];
  const tables: unknown[][] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://cloud.test", token: "token", output: "text" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch: async (path, init) => {
      calls.push({ path, init });
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch: ${path}`);
      return response;
    },
    readJson: async (response) => {
      const text = await response.text();
      const value = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(typeof value?.message === "string" ? value.message : response.statusText);
      return value;
    },
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => lines.push(value),
    json: (value) => lines.push(JSON.stringify(value, null, 2)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: (rows) => tables.push(rows),
  };
  return { ctx, calls, lines, tables };
};

const cli = defineCliCommands({
  name: "grids",
  summary: "Grids test CLI",
  commands: [...workflowCommands, ...workflowRunCommands],
});

const basePage = { items: [{ id: baseId, name: "Bookshop" }], total: 1, limit: 500, offset: 0 };
const resolutionResponses = () => [jsonResponse(basePage), jsonResponse([workflow])];

describe("Grids workflow CLI", () => {
  test("keeps the reference invocation aligned with a compilable and bindable YAML example", async () => {
    expect(WORKFLOW_REFERENCE.invocation.direct.inputs).toEqual({ item: "00000000-0000-4000-8000-000000000001" });
    expect(WORKFLOW_REFERENCE.launchers.correctionDraft.config.intent).toBe("correction");
    expect(WORKFLOW_REFERENCE.launchers.cancellationDraft.config.intent).toBe("cancellation");

    const compiled = await compileWorkflow(WORKFLOW_REFERENCE.example, gridsWorkflows);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const catalog = buildWorkflowCatalog({
      tables: [{ id: baseId, shortId: "items1", name: "Items", kind: "stored" }],
      fieldsByTable: new Map([[baseId, [{ id: itemRecordId, shortId: "status", name: "Status" }]]]),
    });
    expect((await bindGridsWorkflow(compiled.ir, catalog)).ok).toBe(true);

    const closeSelection = await compileWorkflow(WORKFLOW_REFERENCE.closeSelectionExample, gridsWorkflows);
    expect(closeSelection.ok).toBe(true);
    if (!closeSelection.ok) return;
    const boundCloseSelection = await bindGridsWorkflow(closeSelection.ir, catalog);
    expect(boundCloseSelection.ok).toBe(true);
    expect(BulkLauncherRequestSchema.safeParse(WORKFLOW_REFERENCE.invocation.closeSelectionRecordIds).success).toBe(true);
  });

  test("documents only kernel direct invocation and launcher JSON shapes", async () => {
    const direct = createContext(["workflows", "invoke"], { help: true });
    await cli.run(direct.ctx);
    const directHelp = direct.lines.join("\n");
    expect(directHelp).toContain("--mode <value>");
    expect(directHelp).toContain("Values: execute, dryRun.");
    expect(directHelp).toContain("--inputs <json>");
    expect(directHelp).toContain("--idempotency-key <value>");
    expect(directHelp).toContain("Required stable key");
    expect(directHelp).toContain("--expected-revision <value>");
    expect(directHelp).not.toContain("bulk-selection");

    const create = createContext(["workflow-launchers", "create"], { help: true });
    await cli.run(create.ctx);
    const createHelp = create.lines.join("\n");
    expect(createHelp).toContain('"kind":"scanner"');
    expect(createHelp).toContain('"kind":"bulk"');
    expect(createHelp).toContain('"kind":"customApp"');

    const invoke = createContext(["workflow-launchers", "invoke"], { help: true });
    await cli.run(invoke.ctx);
    const invokeHelp = invoke.lines.join("\n");
    expect(invokeHelp).toContain('"scannedText":"gsc_opaque"');
    expect(invokeHelp).toContain('"recordIds":[public-id,...]');
    expect(invokeHelp).toContain('"query":{...}');
  });

  test("invokes a workflow through the CLI route with the kernel envelope", async () => {
    const missingKey = createContext(["workflows", "invoke", baseId, workflowId], { inputs: "{}" });
    await expect(cli.run(missingKey.ctx)).rejects.toThrow("Missing required flag --idempotency-key");
    expect(missingKey.calls).toHaveLength(0);

    const { ctx, calls, lines } = createContext(
      ["workflows", "invoke", baseId, workflowId],
      {
        inputs: '{"email":"ada@example.test"}',
        mode: "dryRun",
        "idempotency-key": "preview-42",
        "expected-revision": "3",
      },
      [...resolutionResponses(), jsonResponse({ ...receipt, mode: "dryRun" })],
    );

    await cli.run(ctx);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/grids/bases?q=${baseId}&limit=500&offset=0`,
      `/api/grids/workflows/by-base/${baseId}`,
      `/api/grids/workflows/${workflowId}/invoke/cli`,
    ]);
    expect(calls[2]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      mode: "dryRun",
      inputs: { email: "ada@example.test" },
      idempotencyKey: "preview-42",
      expectedRevision: 3,
    });
    expect(lines).toEqual([`Created workflow run ${runId} (queued).`]);
  });

  test("uses explicit launcher list, create, update, and delete routes", async () => {
    const list = createContext(["workflow-launchers", "list", baseId, workflowId], {}, [
      ...resolutionResponses(),
      jsonResponse({ items: [launcher("bulk")] }),
    ]);
    await cli.run(list.ctx);
    expect(list.calls.at(-1)?.path).toBe(`/api/grids/workflows/${workflowId}/launchers`);
    expect(list.tables[0]).toEqual([
      {
        id: "ln001A",
        name: "bulk launcher",
        kind: "bulk",
        enabled: "yes",
        revision: 3,
        diagnostics: 0,
      },
    ]);

    const createBody = { name: "Bulk", config: { kind: "bulk", input: "items" } };
    const create = createContext(["workflow-launchers", "create", baseId, workflowId], { body: JSON.stringify(createBody) }, [
      ...resolutionResponses(),
      jsonResponse(launcher("bulk"), 201),
    ]);
    await cli.run(create.ctx);
    expect(create.calls.at(-1)?.path).toBe(`/api/grids/workflows/${workflowId}/launchers`);
    expect(JSON.parse(String(create.calls.at(-1)?.init?.body))).toEqual(createBody);

    const update = createContext(["workflow-launchers", "update", baseId, workflowId, launcherId], { body: '{"enabled":false}' }, [
      ...resolutionResponses(),
      jsonResponse({ items: [launcher("bulk")] }),
      jsonResponse({ ...launcher("bulk"), enabled: false }),
    ]);
    await cli.run(update.ctx);
    expect(update.calls.at(-1)?.path).toBe(`/api/grids/workflows/launchers/${launcherId}`);
    expect(update.calls.at(-1)?.init?.method).toBe("PATCH");

    const remove = createContext(["workflow-launchers", "delete", baseId, workflowId, launcherId], { yes: true }, [
      ...resolutionResponses(),
      jsonResponse({ items: [launcher("bulk")] }),
      new Response(null, { status: 204 }),
    ]);
    await cli.run(remove.ctx);
    expect(remove.calls.at(-1)?.path).toBe(`/api/grids/workflows/launchers/${launcherId}`);
    expect(remove.calls.at(-1)?.init?.method).toBe("DELETE");
  });

  test("routes launcher invocation by the stored launcher kind without changing its JSON body", async () => {
    const bodies = {
      scanner: { operationId: "scan-1", mode: "execute", expectedRevision: 3, scannedText: "gsc_opaque", inputs: {} },
      bulk: { operationId: "bulk-1", mode: "dryRun", expectedRevision: 3, recordIds: [baseId], inputs: {} },
      record: { operationId: "record-1", mode: "execute", expectedRevision: 3, recordId: itemRecordId, inputs: {} },
      customApp: { operationId: "app-1", mode: "execute", expectedRevision: 3, inputs: { range: "30d" } },
    } as const;

    for (const kind of ["scanner", "bulk", "record", "customApp"] as const) {
      const { ctx, calls } = createContext(
        ["workflow-launchers", "invoke", baseId, workflowId, launcherId],
        { body: JSON.stringify(bodies[kind]) },
        [...resolutionResponses(), jsonResponse({ items: [launcher(kind)] }), jsonResponse({ ...receipt, channel: kind })],
      );

      await cli.run(ctx);

      expect(calls.at(-1)?.path).toBe(`/api/grids/workflows/launchers/${launcherId}/invoke/${kind === "customApp" ? "custom-app" : kind}`);
      expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual(bodies[kind]);
    }
  });

  test("lists immutable workflow revisions and restores one as a new revision", async () => {
    const history = createContext(["workflows", "history", baseId, workflowId], { limit: "2" }, [
      ...resolutionResponses(),
      jsonResponse({ items: [revision(3), revision(2)], nextRevision: 2 }),
    ]);
    await cli.run(history.ctx);
    expect(history.calls.at(-1)?.path).toBe(`/api/grids/workflows/${workflowId}/revisions?limit=2`);
    expect(history.tables[0]).toEqual([
      expect.objectContaining({ revision: 3, name: "Check in revision 3" }),
      expect.objectContaining({ revision: 2, name: "Check in revision 2" }),
    ]);
    expect(history.lines).toContain("next revision: 2");

    const missingConfirmation = createContext(["workflows", "restore", baseId, workflowId], { revision: "1" });
    await expect(cli.run(missingConfirmation.ctx)).rejects.toThrow("Pass --yes to restore.");
    expect(missingConfirmation.calls).toHaveLength(0);

    const restore = createContext(["workflows", "restore", baseId, workflowId], { revision: "1", yes: true }, [
      ...resolutionResponses(),
      jsonResponse({ ...workflow, revision: 4, name: "Check in revision 1" }),
    ]);
    await cli.run(restore.ctx);
    expect(restore.calls.at(-1)?.path).toBe(`/api/grids/workflows/${workflowId}/revisions/1/restore`);
    expect(restore.calls.at(-1)?.init?.method).toBe("POST");
    expect(JSON.parse(String(restore.calls.at(-1)?.init?.body))).toEqual({ expectedRevision: 3 });
  });

  test("requires confirmation before canceling an active run", async () => {
    const missingConfirmation = createContext(["workflow-runs", "cancel", runId]);
    await expect(cli.run(missingConfirmation.ctx)).rejects.toThrow("Pass --yes to cancel.");
    expect(missingConfirmation.calls).toHaveLength(0);

    const cancel = createContext(["workflow-runs", "cancel", runId], { yes: true }, [
      jsonResponse({
        ...receipt,
        id: runId,
        baseId,
        launcherId: null,
        workflowRevision: 3,
        actorUserId: null,
        serviceAccountId: null,
        inputs: {},
        result: null,
        error: null,
        resultMessage: null,
        status: "canceled",
        createdAt: "2026-07-15T00:00:00.000Z",
        startedAt: "2026-07-15T00:00:00.100Z",
        finishedAt: "2026-07-15T00:00:00.200Z",
      }),
    ]);
    await cli.run(cancel.ctx);
    expect(cancel.calls.at(-1)?.path).toBe(`/api/grids/workflows/runs/${runId}/cancel`);
    expect(cancel.calls.at(-1)?.init?.method).toBe("POST");
    expect(cancel.lines).toEqual([`Canceled workflow run ${runId}.`]);
  });

  test("projects kernel run and step fields for table output", () => {
    expect(
      workflowRunRows([
        {
          id: runId,
          workflowId,
          launcherId,
          baseId,
          workflowRevision: 3,
          mode: "dryRun",
          channel: "api",
          actorUserId: null,
          serviceAccountId: null,
          inputs: {},
          status: "failed",
          result: null,
          error: { code: "invalid_input", message: "bad input", retryable: false },
          resultMessage: null,
          createdAt: "2026-07-15T00:00:00.000Z",
          startedAt: null,
          finishedAt: "2026-07-15T00:00:01.000Z",
        },
      ]),
    ).toEqual([expect.objectContaining({ revision: 3, channel: "api", mode: "dryRun", status: "failed" })]);

    expect(
      workflowStepRows([
        {
          runId,
          key: "steps.0@0",
          sourcePath: ["steps", 0],
          iterationPath: [],
          kind: "action",
          action: "updateRecord",
          status: "unsupported",
          outcome: { reason: "dry run" },
          executionGeneration: 2,
          startedAt: null,
          finishedAt: null,
        },
      ]),
    ).toEqual([
      {
        key: "steps.0@0",
        path: "steps.0",
        iteration: "",
        kind: "action",
        action: "updateRecord",
        status: "unsupported",
        attempt: 2,
        outcome: '{"reason":"dry run"}',
      },
    ]);
  });

  test("describes step states with the step vocabulary and never the run's", async () => {
    const steps = createContext(["workflow-runs", "steps"], { help: true });
    await cli.run(steps.ctx);
    const stepsHelp = steps.lines.join("\n");
    for (const state of ["completed", "planned", "terminal", "unsupported", "indeterminate", "needs_attention"]) {
      expect(stepsHelp).toContain(state);
    }
    // A run succeeds and is queued; a step does neither, and saying otherwise is
    // what rendered a finished step as though it were still going.
    expect(stepsHelp).not.toContain("succeeded");
    expect(stepsHelp).not.toContain("queued");
    expect(stepsHelp).toContain("ATTEMPT");

    // The mirror image: --status filters runs, so it offers run states and no
    // step-only word.
    const runs = createContext(["workflow-runs", "list"], { help: true });
    await cli.run(runs.ctx);
    const runsHelp = runs.lines.join("\n");
    expect(runsHelp).toContain("Values: queued, running, waiting, succeeded, failed, canceled, needs_attention.");
    for (const state of ["planned", "terminal", "unsupported", "indeterminate"]) {
      expect(runsHelp).not.toContain(state);
    }
  });

  test("reports a cancel that the worker still has to honour", async () => {
    const { ctx, lines } = createContext(["workflow-runs", "cancel", runId], { yes: true }, [
      jsonResponse({ ...receipt, id: runId, status: "running" }),
    ]);
    await cli.run(ctx);
    expect(lines).toEqual([`Requested cancellation of workflow run ${runId}; it is still running.`]);
  });
});
