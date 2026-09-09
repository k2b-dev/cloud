import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fail, ok } from "@k2b/stdlib";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext, PermissionLevel } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import { gridsService } from "../service";
import * as publicResources from "../service/public-resources";
import {
  type GridsWorkflow,
  type GridsWorkflowRevision,
  WORKFLOW_REVISION_HEADER,
  type WorkflowTriggerRuntimeState,
} from "../workflows/contracts";
import { createWorkflowCatalogRoutes } from "./workflow-catalog-routes";

const baseId = "11111111-1111-4111-8111-111111111111";
const workflowId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const basePublicId = "base01";
const workflowPublicId = "work01";

const publicResourceMocks = {
  resolvePublicId: async (type: string, publicId: string) => {
    if (type === "base" && publicId === basePublicId) return baseId;
    if (type === "workflow" && publicId === workflowPublicId) return workflowId;
    return null;
  },
  resolvePublicIds: async () => new Map(),
  projectPublicIds: async (type: string, internalIds: readonly string[]) =>
    new Map(
      internalIds.flatMap((internalId) => {
        if (type === "base" && internalId === baseId) return [[internalId, basePublicId]];
        if (type === "workflow" && internalId === workflowId) return [[internalId, workflowPublicId]];
        return [];
      }),
    ),
};

const user: User = {
  id: userId,
  uid: "workflow-editor",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Workflow",
  sn: "Editor",
  displayName: "Workflow Editor",
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

const workflow: GridsWorkflow = {
  id: workflowId,
  shortId: workflowPublicId,
  baseId,
  name: "Notify",
  description: null,
  source: "steps:\n  - succeed:\n      message: done",
  plan: {} as GridsWorkflow["plan"],
  diagnostics: [],
  enabled: true,
  position: 0,
  revision: 2,
  ownerUserId: userId,
  deletedAt: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

let permissionLevel: PermissionLevel = "admin";
let updateRevision: number | null = null;
let getWorkflowCalls = 0;
let includeDeletedWorkflowReads: boolean[] = [];
let restoredRevision: number | null = null;
let restoreExpectedRevision: number | null = null;

const revision: GridsWorkflowRevision = {
  workflowId,
  revision: 1,
  name: "Original",
  description: null,
  source: workflow.source,
  plan: workflow.plan,
  diagnostics: [],
  position: 0,
  actorUserId: userId,
  createdAt: workflow.createdAt,
};
const triggerState: WorkflowTriggerRuntimeState = {
  schedule: {
    cron: "0 8 * * *",
    timezone: "Europe/Berlin",
    state: "reconciled",
    nextRunAt: "2026-07-26T06:00:00.000Z",
    problem: null,
  },
  recordEvents: [],
};

const getWorkflow = async (_id: string, includeDeleted = false) => {
  getWorkflowCalls += 1;
  includeDeletedWorkflowReads.push(includeDeleted);
  return workflow;
};

const updateWorkflow = async (_id: string, input: { name?: string }, _actorId: string | null, expectedRevision: number) => {
  updateRevision = expectedRevision;
  if (expectedRevision !== workflow.revision) {
    return fail({
      code: "CONFLICT" as const,
      message: "Workflow changed since you opened it. Reload the latest version before saving.",
      status: 409 as const,
    });
  }
  return ok({ ...workflow, ...input, revision: workflow.revision + 1 });
};

const restoreWorkflowRevision = async (_id: string, restoreRevision: number, _actorId: string | null, expectedRevision: number) => {
  restoredRevision = restoreRevision;
  restoreExpectedRevision = expectedRevision;
  return ok({ ...workflow, revision: workflow.revision + 1, name: revision.name });
};

const authenticated: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  await next();
};

const app = () =>
  new Hono<AuthContext>().use("*", authenticated).route(
    "/workflows",
    createWorkflowCatalogRoutes({
      getWorkflow,
      getWorkflowRevision: async (_id, itemRevision) => (itemRevision === revision.revision ? revision : null),
      getWorkflowTriggerRuntimeState: async () => triggerState,
      listWorkflowRevisions: async () => ({ items: [revision], nextRevision: null }),
      restoreWorkflowRevision,
      updateWorkflow,
    }),
  );

const patchWorkflow = (revision?: number) =>
  app().request(`/workflows/${workflowPublicId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(revision === undefined ? {} : { [WORKFLOW_REVISION_HEADER]: String(revision) }),
    },
    body: JSON.stringify({ name: "Updated" }),
  });

describe("workflow catalog update route", () => {
  beforeEach(() => {
    spyOn(publicResources, "resolvePublicId").mockImplementation(publicResourceMocks.resolvePublicId);
    spyOn(publicResources, "resolvePublicIds").mockImplementation(publicResourceMocks.resolvePublicIds);
    spyOn(publicResources, "projectPublicIds").mockImplementation(publicResourceMocks.projectPublicIds);
    permissionLevel = "admin";
    updateRevision = null;
    getWorkflowCalls = 0;
    includeDeletedWorkflowReads = [];
    restoredRevision = null;
    restoreExpectedRevision = null;
    spyOn(gridsService.workflow, "get").mockImplementation(async () => workflow);
    spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockImplementation(async () => []);
    spyOn(gridsService.permission, "resolve").mockImplementation(() => permissionLevel);
  });

  afterEach(() => mock.restore());

  test("publishes the required revision header in OpenAPI", async () => {
    const spec = await generateSpecs(app());
    const operation = spec.paths?.["/workflows/{workflowId}"]?.patch;

    expect(operation?.parameters).toContainEqual({
      name: WORKFLOW_REVISION_HEADER,
      in: "header",
      required: true,
      description: "Current workflow revision returned by the API.",
      schema: { type: "integer", minimum: 1 },
    });
  });

  test("publishes base id error responses in OpenAPI", async () => {
    const spec = await generateSpecs(app());
    const responses = spec.paths?.["/workflows/by-base/{baseId}/validate"]?.post?.responses;

    expect(Object.keys(responses ?? {})).toEqual(["200", "400", "403", "404"]);
  });

  test("rejects invalid workflow ids before reading the store", async () => {
    const response = await app().request("/workflows/not-an-id");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Invalid workflow id" });
    expect(getWorkflowCalls).toBe(0);
  });

  test("requires a valid workflow revision", async () => {
    const response = await patchWorkflow();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: `${WORKFLOW_REVISION_HEADER} must contain the workflow revision.` });
    expect(updateRevision).toBeNull();
  });

  test("returns 409 for a stale workflow revision", async () => {
    const response = await patchWorkflow(workflow.revision - 1);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "CONFLICT",
      message: "Workflow changed since you opened it. Reload the latest version before saving.",
    });
    expect(updateRevision).toBe(workflow.revision - 1);
  });

  test("updates the matching workflow revision", async () => {
    const response = await patchWorkflow(workflow.revision);

    expect(response.status).toBe(200);
    expect((await response.json()).revision).toBe(workflow.revision + 1);
    expect(updateRevision).toBe(workflow.revision);
  });

  test("allows readers to inspect immutable workflow revisions", async () => {
    permissionLevel = "read";

    const listResponse = await app().request(`/workflows/${workflowPublicId}/revisions`);
    const itemResponse = await app().request(`/workflows/${workflowPublicId}/revisions/${revision.revision}`);

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      items: [
        {
          workflowId: workflowPublicId,
          revision: revision.revision,
          name: revision.name,
          actorUserId: revision.actorUserId,
          createdAt: revision.createdAt,
        },
      ],
      nextRevision: null,
    });
    expect(itemResponse.status).toBe(200);
    expect(await itemResponse.json()).toEqual({ ...revision, workflowId: workflowPublicId });
    expect(includeDeletedWorkflowReads).toEqual([true, true]);
  });

  test("allows readers to inspect automatic trigger runtime state", async () => {
    permissionLevel = "read";

    const response = await app().request(`/workflows/${workflowPublicId}/trigger-state`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(triggerState);
  });

  test("requires admin access and the current revision to restore history", async () => {
    permissionLevel = "read";
    const forbidden = await app().request(`/workflows/${workflowPublicId}/revisions/${revision.revision}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: workflow.revision }),
    });
    expect(forbidden.status).toBe(403);
    expect(restoredRevision).toBeNull();

    permissionLevel = "admin";
    const response = await app().request(`/workflows/${workflowPublicId}/revisions/${revision.revision}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: workflow.revision }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).revision).toBe(workflow.revision + 1);
    expect(restoredRevision).toBe(revision.revision);
    expect(restoreExpectedRevision).toBe(workflow.revision);
  });
});
