import { type AuthContext, auth } from "@valentinkolb/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import {
  projectPublicWorkspaceRecordDetail,
  projectPublicWorkspaceWorkflowRunDetail,
} from "../frontend/_components/workspace/workspace-public-state";
import { loadRecordDetailData } from "../frontend/_components/workspace/workspace-record-detail-state";
import { loadWorkflowRunDetail } from "../frontend/_components/workspace/workspace-workflow-state";
import { gridsService } from "../service";
import { apiMessages } from "./messages";
import { currentActorViewer, gateAt } from "./permissions";
import { v } from "./validator";

export const createWorkspaceApi = (
  deps: {
    requireAuthenticated?: MiddlewareHandler<AuthContext>;
    getTable?: typeof gridsService.table.get;
    getTableByShortId?: typeof gridsService.table.getByShortId;
    getRecord?: typeof gridsService.record.get;
    getRecordByShortId?: typeof gridsService.record.getByShortId;
    listFields?: typeof gridsService.field.listByTable;
    gate?: typeof gateAt;
    loadRecordDetail?: typeof loadRecordDetailData;
    projectRecordDetail?: typeof projectPublicWorkspaceRecordDetail;
    viewer?: typeof currentActorViewer;
    getWorkflowRun?: typeof gridsService.workflow.getRun;
    getWorkflowRunByShortId?: typeof gridsService.workflow.getRunByShortId;
    getWorkflow?: typeof gridsService.workflow.get;
    loadWorkflowDetail?: typeof loadWorkflowRunDetail;
    projectWorkflowDetail?: typeof projectPublicWorkspaceWorkflowRunDetail;
  } = {},
) => {
  const gate = deps.gate ?? gateAt;

  return new Hono<AuthContext>()
    .use(deps.requireAuthenticated ?? auth.requireRole("authenticated"))
    .get(
      "/record-detail",
      v(
        "query",
        z.object({
          tableId: ShortIdSchema,
          recordId: ShortIdSchema,
          deletedOnly: z.enum(["true"]).optional(),
        }),
      ),
      async (c) => {
        const { tableId: tablePublicId, recordId: recordPublicId, deletedOnly } = c.req.valid("query");
        const table = await (deps.getTableByShortId ?? gridsService.table.getByShortId)(tablePublicId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const tableId = table.id;
        const tableAccess = await gate(c, { baseId: table.baseId }, "read");
        if (!tableAccess.ok) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        const record = await (deps.getRecordByShortId ?? gridsService.record.getByShortId)(recordPublicId);
        if (!record || record.tableId !== tableId || (deletedOnly ? !record.deletedAt : record.deletedAt)) {
          return c.json({ message: apiMessages(c).recordNotFound }, 404);
        }
        const loadFields = () => (deps.listFields ?? gridsService.field.listByTable)(tableId);
        const detailFields = await loadFields();
        const loadRecordDetail = deps.loadRecordDetail ?? loadRecordDetailData;
        const detail = await loadRecordDetail({
          tableId,
          recordId: record.id,
          record,
          fields: detailFields ?? [],
          viewer: (deps.viewer ?? currentActorViewer)(c),
          scope: "full",
        });
        return c.json(await (deps.projectRecordDetail ?? projectPublicWorkspaceRecordDetail)(detail, detailFields ?? []));
      },
    )
    .get("/workflow-run-detail", v("query", z.object({ runId: ShortIdSchema })), async (c) => {
      const getWorkflowRun = deps.getWorkflowRunByShortId ?? gridsService.workflow.getRunByShortId;
      const run = await getWorkflowRun(c.req.valid("query").runId);
      if (!run?.workflowId) return c.json({ message: apiMessages(c).workflowRunNotFound }, 404);
      const access = await gate(c, { baseId: run.baseId }, "read");
      if (!access.ok) return c.json({ message: apiMessages(c).workflowRunNotFound }, 404);
      const loadWorkflowDetail = deps.loadWorkflowDetail ?? loadWorkflowRunDetail;
      const workflow = await (deps.getWorkflow ?? gridsService.workflow.get)(run.workflowId, true);
      const detail = await loadWorkflowDetail(run, {
        canReadDocument: async (document) => (await gate(c, { baseId: document.baseId }, "read")).ok,
        workflow,
        viewer: (deps.viewer ?? currentActorViewer)(c),
      });
      return c.json(await (deps.projectWorkflowDetail ?? projectPublicWorkspaceWorkflowRunDetail)(detail));
    });
};

export default createWorkspaceApi();
