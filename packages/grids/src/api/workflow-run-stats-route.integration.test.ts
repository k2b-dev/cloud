import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../integration-test-utils";
import { migrate } from "../migrate";
import { deleteTestWorkflowScope, insertTestWorkflow, insertTestWorkflowRun } from "../service/workflow-test-fixture";
import { PublicGridsWorkflowRunStatsSchema } from "./workflow-public-contracts";
import { createWorkflowRunRoutes } from "./workflow-run-routes";

const postgresTest = testFor("database");
const uuid = () => Bun.randomUUIDv7();

// The run stats narrowed to one workflow answer only for a workflow the caller may read on that base: a workflow of
// another base or an id that names nothing is "not found", as on the run list; the caller's own one carries its series.
const fixture = {
  userId: uuid(),
  accessId: "",
  baseId: uuid(),
  basePublicId: testShortId(),
  otherBaseId: uuid(),
  workflowId: uuid(),
  workflowPublicId: testShortId(),
  foreignWorkflowId: uuid(),
  foreignWorkflowPublicId: testShortId(),
};

const api = () => {
  const user: User = {
    id: fixture.userId,
    uid: `run-stats-${fixture.userId}`,
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Run",
    sn: "Stats",
    displayName: "Run Stats",
    mail: "run-stats@example.test",
    avatarHash: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  };
  return new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("accessSubject", { type: "user", userId: fixture.userId });
      await next();
    })
    .route("/", createWorkflowRunRoutes());
};

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${fixture.userId}::uuid, ${`run-stats-${fixture.userId}`}, 'local', 'user', 'Run Stats', 'Run', 'Stats')`;
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES
    (${fixture.baseId}::uuid, ${fixture.basePublicId}, 'Run stats route'),
    (${fixture.otherBaseId}::uuid, ${testShortId()}, 'Another base')`;
  await insertTestWorkflow({
    id: fixture.workflowId,
    baseId: fixture.baseId,
    name: "Own",
    shortId: fixture.workflowPublicId,
    enabled: true,
  });
  await insertTestWorkflow({
    id: fixture.foreignWorkflowId,
    baseId: fixture.otherBaseId,
    name: "Foreign",
    shortId: fixture.foreignWorkflowPublicId,
    enabled: true,
  });
  await insertTestWorkflowRun({ workflowId: fixture.workflowId, baseId: fixture.baseId, state: "failed", createdAt: new Date() });
  await insertTestWorkflowRun({
    workflowId: fixture.foreignWorkflowId,
    baseId: fixture.otherBaseId,
    state: "succeeded",
    createdAt: new Date(),
  });
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission) VALUES (${fixture.userId}::uuid, 'read'::auth.permission_level) RETURNING id::text AS id
  `;
  fixture.accessId = access!.id;
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${fixture.baseId}::uuid, ${fixture.accessId}::uuid)`;
});

afterAll(async () => {
  if (!testInfra.database) return;
  await deleteTestWorkflowScope(fixture.baseId);
  await deleteTestWorkflowScope(fixture.otherBaseId);
  await sql`DELETE FROM grids.bases WHERE id IN (${fixture.baseId}::uuid, ${fixture.otherBaseId}::uuid)`;
  if (fixture.accessId) await sql`DELETE FROM auth.access WHERE id = ${fixture.accessId}::uuid`;
  await sql`DELETE FROM auth.users WHERE id = ${fixture.userId}::uuid`;
});

describe("workflow run stats route", () => {
  const path = (workflowId: string) => `/by-base/${fixture.basePublicId}/run-stats?window=24h&workflowId=${workflowId}`;

  postgresTest("a workflow of another base is not found, and its runs stay out of the answer", async () => {
    const response = await api().request(path(fixture.foreignWorkflowPublicId));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(fixture.foreignWorkflowPublicId);
  });

  postgresTest("a workflow id that names nothing is not found", async () => {
    const response = await api().request(path(testShortId()));
    expect(response.status).toBe(404);
  });

  postgresTest("the caller's own workflow answers with its counts and its series", async () => {
    const response = await api().request(path(fixture.workflowPublicId));
    expect(response.status).toBe(200);
    const stats = PublicGridsWorkflowRunStatsSchema.parse(await response.json());
    expect(stats.total).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.series.bucket).toBe("1h");
    expect(stats.series.points.reduce((sum, point) => sum + point.failed, 0)).toBe(1);
  });
});
