import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { migrateCloudAi } from "../ai/migrate";
import { aiConversations } from "../ai/store";
import type { RuntimeAppMeta } from "../contracts/app";
import { APPROVAL_ACP_CLIENT, APPROVAL_CLIENT_HEADER, ApprovalPageSchema } from "../contracts/approvals";
import { accounts } from "../services/accounts";
import { approvals } from "../services/approvals";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { serviceAccounts } from "../services/service-accounts";
import { createTestBrowserSignIn, createTestSession } from "../services/session/session.test-fixture";
import { approvalRoutes } from "./approvals";

const runtimeApps: RuntimeAppMeta[] = [
  {
    id: "mail",
    name: "Mail",
    icon: "ti ti-mail",
    description: "Email",
    routes: ["/app/mail"],
    presentation: { baseLocale: "en", translations: { de: { name: "Post" } } },
  },
];
const routes = new Hono<{ Variables: { runtime: { apps: RuntimeAppMeta[] } } }>()
  .use(async (c, next) => {
    c.set("runtime", { apps: runtimeApps });
    await next();
  })
  .route("/", approvalRoutes);

suiteFor(
  "database",
  "nats",
  "valkey",
)("Core pending approvals API", () => {
  beforeAll(migrateCloudAi);
  test("indexes approval lookups for pending and resolved actions", async () => {
    const [index] = await sql<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes
      WHERE schemaname='ai' AND tablename='pending_actions' AND indexname='idx_ai_pending_actions_approval'`;
    expect(index?.indexdef).toContain("(approval_id)");
    expect(index?.indexdef).toContain("WHERE (approval_id IS NOT NULL)");
    expect(index?.indexdef).not.toContain("status");
  });
  test("lists localized requests and counts, decides through chat, and keeps retries and channel rules", async () => {
    const users: string[] = [];
    const serviceAccountIds: string[] = [];
    const fixture = async () => {
      const uid = `approval-http-${crypto.randomUUID()}`;
      const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,mail)
        VALUES(${uid},'local','user',${`${uid}@example.test`}) RETURNING id`;
      if (!user) throw new Error("Missing fixture user");
      users.push(user.id);
      const chat = await aiConversations.createConversation({ ownerUserId: user.id });
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "mock",
        runConfig: { kind: "chat", input: "Send" },
        userMessage: { role: "user", content: [{ type: "text", text: "Send" }] },
      });
      const headers = {
        Authorization: `Bearer ${await createTestSession(user.id)}`,
        "Content-Type": "application/json",
        "Accept-Language": "de",
      };
      const ask = async (assurance: "confirm" | "standard" = "confirm") => {
        const callId = crypto.randomUUID();
        const request = await approvals.request({
          appId: "mail",
          action: "draft.send",
          requester: { kind: "assistant_turn", appId: "assistant", ref: `${turn.id}/${callId}` },
          subjectId: user.id,
          approverUserId: user.id,
          assurance,
          sentence: "Mail: Send draft",
          input: {},
          expiresInMs: 600_000,
        });
        if (!request.ok) throw new Error("Missing approval");
        await aiConversations.savePendingTurnAction({
          approvalId: request.id,
          conversationId: chat.id,
          turnId: turn.id,
          callId,
          kind: "approval",
          status: "pending",
          name: "mail.draft.send",
          args: {},
          allowAlways: assurance === "standard",
          allowChat: assurance === "standard",
          approvalScope: "draft",
          resolvedEvent: null,
        });
        return { id: request.id, callId };
      };
      return { userId: user.id, chat, turn, headers, ask };
    };
    try {
      const owner = await fixture();
      const other = await fixture();
      const confirm = await owner.ask();
      const foreign = await other.ask();
      const decide = (id: string, approved: boolean, client?: string, remember?: "chat" | "always") =>
        routes.request(`/${id}/decision`, {
          method: "POST",
          headers: { ...owner.headers, ...(client ? { [APPROVAL_CLIENT_HEADER]: client } : {}) },
          body: JSON.stringify({ approved, remember }),
        });
      const list = await routes.request("/?app=mail", { headers: owner.headers });
      expect(list.status).toBe(200);
      const page = ApprovalPageSchema.parse(await list.json());
      expect(page).toMatchObject({ count: 1, elsewhere: 0 });
      expect(page.items[0]).toMatchObject({
        id: confirm.id,
        app: { id: "mail", name: "Post", icon: "ti ti-mail" },
        remember: { chat: false, always: false },
      });
      const counts = await routes.request("/counts", { headers: owner.headers });
      expect(counts.status).toBe(200);
      expect(counts.headers.get("X-RateLimit-Limit")).toMatch(/^\d+$/);
      expect(await counts.json()).toEqual({ total: 1, apps: { mail: 1, assistant: 1 } });
      expect((await decide(foreign.id, true)).status).toBe(404);
      expect((await decide(confirm.id, true, undefined, "always")).status).toBe(400);
      const blocked = await decide(confirm.id, true, APPROVAL_ACP_CLIENT);
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({
        code: "FORBIDDEN",
        message: "Approve this request in Cloud. An editor can only reject it.",
      });
      expect(await approvals.get(confirm.id)).toMatchObject({ status: "pending" });
      expect(
        (await aiConversations.getPendingTurnAction({ conversationId: owner.chat.id, turnId: owner.turn.id, callId: confirm.callId }))
          ?.status,
      ).toBe("pending");
      const approved = await decide(confirm.id, true);
      expect(approved.status).toBe(200);
      expect(await approved.json()).toEqual({ status: "approved" });
      expect(
        await aiConversations.getPendingTurnAction({ conversationId: owner.chat.id, turnId: owner.turn.id, callId: confirm.callId }),
      ).toMatchObject({ status: "resolved", resolvedEvent: { type: "approval_response", callId: confirm.callId, approved: true } });
      expect((await decide(confirm.id, true)).status).toBe(200);
      const replay = await decide(confirm.id, true, APPROVAL_ACP_CLIENT);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ status: "approved" });
      expect((await decide(confirm.id, false)).status).toBe(409);
      const standard = await owner.ask("standard");
      expect((await decide(standard.id, true, APPROVAL_ACP_CLIENT, "chat")).status).toBe(200);
      expect(await approvals.get(standard.id)).toMatchObject({ decidedVia: "acp_bridge" });
      const rejected = await owner.ask();
      expect((await decide(rejected.id, false, APPROVAL_ACP_CLIENT)).status).toBe(200);
      const expired = await owner.ask();
      await sql`UPDATE approvals.requests SET expires_at=now()-interval '1 second' WHERE id=${expired.id}::uuid`;
      expect((await decide(expired.id, true)).status).toBe(404);
      expect((await routes.request("/?cursor=invalid", { headers: owner.headers })).status).toBe(400);
      const oversized = await routes.request(`/${confirm.id}/decision`, {
        method: "POST",
        headers: owner.headers,
        body: JSON.stringify({ approved: true, padding: "x".repeat(1024) }),
      });
      expect(oversized.status).toBe(413);
      expect((await routes.request("/counts")).status).toBe(401);
      const user = await accounts.users.get({ id: owner.userId });
      if (!user) throw new Error("Missing fixture user");
      const personal = await serviceAccountCredentials.createUserApiToken({
        browserSignIn: await createTestBrowserSignIn(user.id),
        user,
        name: "Approval API",
      });
      if (!personal.ok) throw new Error(personal.error.message);
      const apiApproval = await owner.ask();
      const personalDecision = await routes.request(`/${apiApproval.id}/decision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${personal.data.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });
      expect(personalDecision.status).toBe(200);
      expect(await approvals.get(apiApproval.id)).toMatchObject({ decidedVia: "api_key" });
      for (const kind of ["standalone", "agent"] as const) {
        const account = await serviceAccounts.createStandalone({
          name: `Approval ${kind} ${crypto.randomUUID()}`,
          kind,
          createdBy: owner.userId,
        });
        if (!account.ok) throw new Error(account.error.message);
        serviceAccountIds.push(account.data.id);
        const credential = await serviceAccountCredentials.createStandaloneApiToken({
          serviceAccountId: account.data.id,
          actor: user,
          name: "Approval access",
        });
        if (!credential.ok) throw new Error(credential.error.message);
        const headers = { Authorization: `Bearer ${credential.data.token}`, "Content-Type": "application/json" };
        expect((await routes.request("/", { headers })).status).toBe(403);
        expect((await routes.request("/counts", { headers })).status).toBe(403);
        expect(
          (await routes.request(`/${foreign.id}/decision`, { method: "POST", headers, body: JSON.stringify({ approved: false }) })).status,
        ).toBe(403);
      }
    } finally {
      for (const id of serviceAccountIds) await sql`DELETE FROM auth.service_accounts WHERE id=${id}::uuid`;
      for (const userId of users) {
        await sql`DELETE FROM audit.events WHERE actor_user_id=${userId}::uuid AND target_type='approval_request'`;
        await sql`DELETE FROM auth.service_accounts WHERE delegated_user_id=${userId}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    }
  });
});
