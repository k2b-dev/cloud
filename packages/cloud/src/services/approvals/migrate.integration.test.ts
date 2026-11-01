import { afterAll, beforeAll, expect, test } from "bun:test";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { migrateApprovals } from ".";

databaseSuite()("approval role upgrade from the personal schema", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("code_approval_upgrade");
    await sql`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY, auth_epoch bigint NOT NULL DEFAULT 0)`.simple();
    await sql`CREATE SCHEMA approvals;
      CREATE TABLE approvals.requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), app_id text NOT NULL, action text NOT NULL, approval_scope text,
        requester_kind text NOT NULL CHECK (requester_kind IN ('assistant_turn','studio_app')),
        requester_ref text NOT NULL, requester_app_id text NOT NULL, requester_title text,
        subject_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        approver_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        assurance text NOT NULL CHECK (assurance IN ('standard','confirm')), sentence text NOT NULL, details jsonb,
        args_digest text NOT NULL, review_digest text NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','cancelled','consumed')),
        decided_via text CHECK (decided_via IS NULL OR decided_via IN ('web_session','app_session','oauth','api_key','invocation','acp_bridge','cloud_login')),
        decided_at timestamptz, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
        decided_device_id uuid, approver_auth_epoch bigint,
        UNIQUE(requester_kind,requester_ref)
      )`.simple();
  });
  afterAll(async () => {
    await database?.drop();
  });
  test("adds role fields twice without changing pending, approved or remembered personal state", async () => {
    const userId = "c5000000-0000-4000-8000-000000000001";
    await sql`INSERT INTO auth.users(id,auth_epoch) VALUES(${userId}::uuid,7)`;
    // Stand-ins for the untouched Assistant-owned tables also retain their exact rows.
    await sql`CREATE SCHEMA ai; CREATE TABLE ai.pending_actions(id text PRIMARY KEY,args jsonb,status text);
      CREATE TABLE ai.tool_approval_preferences(tool_name text PRIMARY KEY,allowed boolean)`.simple();
    await sql`INSERT INTO ai.pending_actions VALUES('old-call','{"spaceId":"old-target"}'::jsonb,'pending')`;
    await sql`INSERT INTO ai.tool_approval_preferences VALUES('spaces.task.create',true)`;
    for (const status of ["pending", "approved", "rejected", "consumed"])
      await sql`INSERT INTO approvals.requests(app_id,action,requester_kind,requester_ref,requester_app_id,subject_id,
        approver_user_id,assurance,sentence,args_digest,review_digest,status,approver_auth_epoch,expires_at)
        VALUES('demo','write','assistant_turn',${status},'demo',${userId}::uuid,${userId}::uuid,'standard','Keep me','args','review',${status},7,'2099-01-01T00:00:00Z')`;
    const before = await sql<
      { row: Record<string, unknown> }[]
    >`SELECT to_jsonb(r) AS row FROM approvals.requests r ORDER BY requester_ref`;
    await migrateApprovals();
    const once = await sql<{ row: Record<string, unknown> }[]>`SELECT to_jsonb(r) AS row FROM approvals.requests r ORDER BY requester_ref`;
    await migrateApprovals();
    const twice = await sql<{ row: Record<string, unknown> }[]>`SELECT to_jsonb(r) AS row FROM approvals.requests r ORDER BY requester_ref`;
    expect([...twice]).toEqual([...once]);
    expect(
      once.map(({ row }) => {
        const { kind, approver_role, author_user_id, decided_by_user_id, requester_href, sole_admin, ...personal } = row;
        expect({ kind, approver_role, author_user_id, decided_by_user_id, requester_href, sole_admin }).toEqual({
          kind: "action",
          sole_admin: false,
          approver_role: null,
          author_user_id: null,
          decided_by_user_id: null,
          requester_href: null,
        });
        return { row: personal };
      }),
    ).toEqual(before);
    const pending = await sql<{ id: string; args: unknown; status: string }[]>`SELECT * FROM ai.pending_actions`;
    expect([...pending]).toEqual([{ id: "old-call", args: { spaceId: "old-target" }, status: "pending" }]);
    const preferences = await sql<{ tool_name: string; allowed: boolean }[]>`SELECT * FROM ai.tool_approval_preferences`;
    expect([...preferences]).toEqual([{ tool_name: "spaces.task.create", allowed: true }]);
  });
});
