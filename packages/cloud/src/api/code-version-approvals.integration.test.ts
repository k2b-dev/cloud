import { expect, test } from "bun:test";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
import { migrateCloudAi } from "../ai/migrate";
import type { RuntimeAppMeta } from "../contracts/app";
import { ApprovalPageSchema } from "../contracts/approvals";
import { sql } from "../runtime/clients";
import { approvalReviewDigest, approvals, registerApprovalDecisionHandler } from "../services/approvals";
import { createTestSession } from "../services/session/session.test-fixture";
import { createDeviceActions } from "./app-approval-actions";
import { approvalRoutes } from "./approvals";

const routes = new Hono<{ Variables: { runtime: { apps: RuntimeAppMeta[] } } }>()
  .use(async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/", approvalRoutes);

suiteFor(
  "database",
  "nats",
  "valkey",
)("Code approvals HTTP and device adapters", () => {
  test("role lists, content and decisions work without chat; device decisions use the same owner transaction", async () => {
    await migrateCloudAi();
    const users: string[] = [];
    const requests: string[] = [];
    let transitions = 0;
    const dispose = registerApprovalDecisionHandler("code_version", async () => {
      transitions++;
    });
    try {
      for (const admin of [false, true]) {
        const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,admin)
          VALUES(${`code-http-${crypto.randomUUID()}`},'local','user',${admin}) RETURNING id`;
        if (!row) throw new Error("Missing fixture user");
        users.push(row.id);
      }
      const author = users[0]!,
        admin = users[1]!;
      const headers = { Authorization: `Bearer ${await createTestSession(admin)}`, "Content-Type": "application/json" };
      const outsiderHeaders = { Authorization: `Bearer ${await createTestSession(author)}`, "Content-Type": "application/json" };
      const review = {
        ...reviewFixture(),
        content: { kind: "page" as const, title: "Source", body: "+ new code", format: "plain" as const },
      };
      const ask = async (fullContent = true, authorUserId = author) => {
        const question = fullContent ? review : { message: "Source diff: + report();" };
        const result = await approvals.request({
          kind: "code_version",
          appId: "demo",
          action: "version.approve",
          authorUserId,
          approverRole: "admin",
          requester: { kind: "code_version", ref: crypto.randomUUID(), appId: "demo", title: "Report", href: "/code/report/" },
          sentence: "Approve Report version 2?",
          input: { codeId: "report", versionId: "v2", sourceHash: "a".repeat(64), bundleHash: "b".repeat(64) },
          review: question,
          expiresInMs: 600_000,
        });
        if (!result.ok) throw new Error("Missing request");
        requests.push(result.id);
        return result.id;
      };
      const id = await ask();
      const response = await routes.request("/", { headers });
      expect(response.status).toBe(200);
      const page = ApprovalPageSchema.parse(await response.json());
      expect(page.items.find((item) => item.id === id)).toMatchObject({
        requester: { kind: "code_version", href: "/code/report/" },
        remember: { chat: false, always: false },
      });
      const counts = await routes.request("/counts", { headers });
      expect(await counts.json()).toMatchObject({ total: 1, apps: { demo: 1 } });
      expect(await (await routes.request("/", { headers: outsiderHeaders })).json()).toMatchObject({ count: 0, items: [] });
      const contentPath = `/${id}/content?digest=${approvalReviewDigest(review)}`;
      expect(await (await routes.request(contentPath, { headers })).json()).toEqual(review.content);
      expect((await routes.request(contentPath, { headers: outsiderHeaders })).status).toBe(404);
      const decide = (approved: boolean, requestHeaders: Record<string, string> = headers, remember?: string) =>
        routes.request(`/${id}/decision`, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({ approved, remember }),
        });
      expect((await decide(true, outsiderHeaders)).status).toBe(404);
      expect((await decide(true, outsiderHeaders, "chat")).status).toBe(404);
      expect((await decide(true, headers, "chat")).status).toBe(400);
      expect((await decide(true, { ...headers, "x-cloud-client": "acp" })).status).toBe(403);
      expect((await decide(true)).status).toBe(200);
      expect((await decide(true)).status).toBe(200);
      expect((await decide(false)).status).toBe(409);
      expect(transitions).toBe(1);
      expect((await routes.request(contentPath, { headers })).status).toBe(404);

      const deviceId = crypto.randomUUID();
      await sql`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted)
        VALUES(${deviceId}::uuid,'https://cloud.example.test',${admin}::uuid,'Phone','{}'::jsonb,false)`;
      const device = createDeviceActions((id) => id);
      const incomplete = await ask();
      expect(await device.view({ userId: admin, issuer: "https://cloud.example.test", actionId: incomplete })).toBeNull();
      const complete = await ask(false);
      const view = await device.view({ userId: admin, issuer: "https://cloud.example.test", actionId: complete });
      expect(view).not.toBeNull();
      if (!view) throw new Error("Expected complete device question");
      expect(
        await device.decide({
          userId: admin,
          deviceId,
          issuer: "https://cloud.example.test",
          actionId: complete,
          digest: "wrong",
          approved: true,
        }),
      ).toBe(false);
      expect(
        await device.decide({
          userId: admin,
          deviceId,
          issuer: "https://cloud.example.test",
          actionId: complete,
          digest: view.digest,
          approved: true,
        }),
      ).toBe(true);
      expect(transitions).toBe(2);
      expect(await approvals.get(complete)).toMatchObject({ status: "approved", decidedByUserId: admin, decidedDeviceId: deviceId });

      // The isolated database may contain bootstrap admins; retain and restore their original flags.
      const previousAdmins = await sql<{ id: string }[]>`UPDATE auth.users SET admin=false
        WHERE admin AND id<>${admin}::uuid RETURNING id`;
      try {
        const own = await ask(false, admin);
        const ownPage = ApprovalPageSchema.parse(
          await (await routes.request("/", { headers: { ...headers, "x-cloud-locale": "de" } })).json(),
        );
        expect(ownPage.items.find((item) => item.id === own)).toMatchObject({
          canApprove: true,
          soleAdminNotice: "Du gibst deinen eigenen Code frei. Es gibt keinen zweiten Cloud-Admin, der ihn prüft.",
        });
        const ownView = await device.view({ userId: admin, issuer: "https://cloud.example.test", actionId: own });
        expect(ownView?.message).toContain("You are approving your own Code.");
        const [family] = await sql<{ sid: string; issued_at: Date }[]>`SELECT sid,issued_at FROM auth.session_families
          WHERE user_id=${admin}::uuid ORDER BY issued_at DESC LIMIT 1`;
        if (!family) throw new Error("Missing browser family");
        await sql`UPDATE auth.session_families SET issued_at='2000-01-01' WHERE sid=${family.sid}::uuid`;
        const decision = () => routes.request(`/${own}/decision`, { method: "POST", headers, body: JSON.stringify({ approved: true }) });
        const reauthenticate = await decision();
        expect(reauthenticate.status).toBe(403);
        expect(await reauthenticate.json()).toMatchObject({ code: "REAUTHENTICATE" });
        expect(await approvals.get(own)).toMatchObject({ status: "pending", soleAdmin: false });
        await sql`UPDATE auth.session_families SET issued_at=${family.issued_at} WHERE sid=${family.sid}::uuid`;
        expect((await decision()).status).toBe(200);
        expect(await approvals.get(own)).toMatchObject({ status: "approved", soleAdmin: true });
        await sql`UPDATE auth.users SET admin=true WHERE id=${author}::uuid`;
        expect(await approvals.get(own)).toMatchObject({ status: "approved", soleAdmin: true });
        const next = await ask(false, admin);
        const nextPage = ApprovalPageSchema.parse(await (await routes.request("/", { headers })).json());
        expect(nextPage.items.find((item) => item.id === next)).toMatchObject({ canApprove: false });
        expect(nextPage.items.find((item) => item.id === next)?.soleAdminNotice).toBeUndefined();
        expect(await device.view({ userId: admin, issuer: "https://cloud.example.test", actionId: next })).toBeNull();
      } finally {
        await sql`UPDATE auth.users SET admin=false WHERE id=${author}::uuid`;
        for (const user of previousAdmins) await sql`UPDATE auth.users SET admin=true WHERE id=${user.id}::uuid`;
      }
    } finally {
      dispose();
      for (const id of requests) await sql`DELETE FROM audit.events WHERE target_type='approval_request' AND target_id=${id}`;
      for (const id of requests) await sql`DELETE FROM approvals.requests WHERE id=${id}::uuid`;
      for (const userId of users) await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
});
