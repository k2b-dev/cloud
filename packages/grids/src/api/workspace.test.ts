import { describe, expect, test } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import type { MiddlewareHandler } from "hono";
import { createWorkspaceApi } from "./workspace";

const tableId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const runId = "55555555-5555-4555-8555-555555555555";
const workflowId = "66666666-6666-4666-8666-666666666666";
const templateId = "77777777-7777-4777-8777-777777777777";
const baseId = "44444444-4444-4444-8444-444444444444";
const tablePublicId = "T4BL01";
const recordPublicId = "R3CRD1";
const runPublicId = "RUN001";
const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "workspace-user",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Workspace",
  sn: "User",
  displayName: "Workspace User",
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

const authenticated: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  await next();
};

describe("Grids workspace record detail", () => {
  const detail = {
    recordId,
    relationLabels: {},
    filesByField: {},
    documents: { items: [], nextCursor: null, hasMore: false },
    snapshots: [],
    auditEntries: [],
    combinedOrigin: null,
  };

  test("does not load record data when table access is denied", async () => {
    let recordCalls = 0;
    const app = createWorkspaceApi({
      requireAuthenticated: authenticated,
      getTableByShortId: async () => ({ id: tableId, baseId }) as never,
      gate: async () => ({ ok: false }) as never,
      getRecordByShortId: async () => {
        recordCalls += 1;
        return {} as never;
      },
    });

    const response = await app.request(`/record-detail?tableId=${tablePublicId}&recordId=${recordPublicId}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Record not found" });
    expect(recordCalls).toBe(0);
  });

  test("returns one composed detail payload for a readable record", async () => {
    const storedRecord = { id: recordId, tableId, data: { relation: ["target"] }, deletedAt: null } as never;
    const publicDetail = {
      recordId: recordPublicId,
      relationLabels: { TARGET: "Camera" },
      filesByField: {},
      documents: { items: [], cursor: null, hasMore: false },
      snapshots: [],
      auditEntries: [],
      combinedOrigin: null,
    };
    let loadedParams: { record: unknown; viewer: { userId: string | null } } | undefined;
    const app = createWorkspaceApi({
      requireAuthenticated: authenticated,
      getTableByShortId: async () => ({ id: tableId, baseId }) as never,
      gate: async () => ({ ok: true, value: "read" }) as never,
      getRecordByShortId: async () => storedRecord,
      listFields: async () => [],
      loadRecordDetail: async (params) => {
        loadedParams = params;
        return { ...detail, relationLabels: { target: "Camera" } };
      },
      projectRecordDetail: async () => publicDetail,
    });

    const response = await app.request(`/record-detail?tableId=${tablePublicId}&recordId=${recordPublicId}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(publicDetail);
    expect(loadedParams?.record).toBe(storedRecord);
    expect(loadedParams?.viewer.userId).toBe(user.id);
  });
});

describe("Grids workspace workflow run detail", () => {
  const run = { id: runId, baseId, workflowId } as never;

  test("does not load run details when workflow access is denied", async () => {
    let detailCalls = 0;
    const app = createWorkspaceApi({
      requireAuthenticated: authenticated,
      getWorkflowRunByShortId: async () => run,
      gate: async () => ({ ok: false }) as never,
      loadWorkflowDetail: async () => {
        detailCalls += 1;
        return {} as never;
      },
    });

    const response = await app.request(`/workflow-run-detail?runId=${runPublicId}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Workflow run not found" });
    expect(detailCalls).toBe(0);
  });

  test("returns one composed payload for a readable workflow run", async () => {
    const detail = {
      run,
      inputLabels: {},
      provenance: { workflowName: null, actorLabel: null, serviceAccountLabel: null, launcherName: null },
      steps: [],
      stepsTruncated: false,
      documents: { items: [], total: 0, hasMore: false, nextOffset: null },
    };
    const publicDetail = { ...detail, run: { id: runPublicId, baseId: "BASE01", workflowId: "WORK01" } };
    let loadedOptions:
      | {
          canReadDocument: (document: { baseId: string; tableId: string; templateId: string }) => Promise<boolean>;
          workflow?: { id: string } | null;
          viewer?: { userId: string | null };
        }
      | undefined;
    const app = createWorkspaceApi({
      requireAuthenticated: authenticated,
      getWorkflowRunByShortId: async () => run,
      getWorkflow: async () => ({ id: workflowId }) as never,
      gate: async () => ({ ok: true, value: "read" }) as never,
      loadWorkflowDetail: async (_run, options) => {
        loadedOptions = options;
        return detail as never;
      },
      projectWorkflowDetail: async () => publicDetail as never,
    });

    const response = await app.request(`/workflow-run-detail?runId=${runPublicId}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(publicDetail);
    expect(loadedOptions?.workflow?.id).toBe(workflowId);
    expect(loadedOptions?.viewer?.userId).toBe(user.id);
    expect(
      await loadedOptions?.canReadDocument({
        baseId,
        tableId,
        templateId,
      }),
    ).toBe(true);
  });
});
