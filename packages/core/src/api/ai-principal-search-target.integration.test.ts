import { afterAll, beforeAll, expect, test } from "bun:test";
import { crypto as stdCrypto } from "@k2b/stdlib";
import { withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { sql } from "@k2b/cloud";
import { aiProjects, aiSkills, migrateCloudAi } from "@k2b/cloud/ai";
import { createCoreApiRouter } from "@k2b/cloud/api";
import { EntityListItemSchema } from "@k2b/cloud/contracts";
import { managesAiPrincipalSearchTarget } from "./ai-principal-search-target";

const unexpectedNotification = async (): Promise<never> => {
  throw new Error("Unexpected notification");
};
const { api } = createCoreApiRouter({
  principalSearchTarget: managesAiPrincipalSearchTarget,
  notifications: {
    sendNewBrowserSignIn: unexpectedNotification,
    sendMagicLink: unexpectedNotification,
    sendIpaLoginHint: unexpectedNotification,
    sendPasswordReset: unexpectedNotification,
  },
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("AI target Kennung lookup through the Core API", () => {
  const handle = `code-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const suffix = crypto.randomUUID();
  const skillShortId = stdCrypto.common.readableId(6);
  const projectShortId = stdCrypto.common.readableId(6);
  let accountId: string;
  const resources: { kind: "skill" | "project"; id: string; shortId: string }[] = [];
  beforeAll(async () => {
    await migrateCloudAi();
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind,handle,title)
      VALUES (${`code:app:lookup-${suffix}`},'code',${handle},'Lookup fixture') RETURNING id`;
    accountId = account!.id;
    const [skill] = await sql<{ id: string; short_id: string }[]>`INSERT INTO ai.skills(short_id,name,description,instructions)
      VALUES (${skillShortId},'lookup-fixture','Lookup fixture','Test instructions') RETURNING id,short_id`;
    const [project] = await sql<{ id: string; short_id: string }[]>`INSERT INTO ai.projects(short_id,name)
      VALUES (${projectShortId},'Lookup fixture') RETURNING id,short_id`;
    resources.push(
      { kind: "skill", id: skill!.id, shortId: skill!.short_id },
      { kind: "project", id: project!.id, shortId: project!.short_id },
    );
  });
  afterAll(async () => {
    for (const resource of resources) {
      if (resource.kind === "skill") await aiSkills.admin.delete(resource.id);
      else await aiProjects.admin.delete(resource.id);
    }
    if (accountId) await sql`DELETE FROM auth.service_accounts WHERE id=${accountId}::uuid`;
  });
  for (const kind of ["skill", "project"] as const) {
    test(`${kind}: only its manager finds the exact Kennung; names, unknown handles and missing targets reveal nothing`, async () => {
      await withAdminOAuth(async ({ sessionHeaders: adminHeaders }) => {
        await withAdminOAuth(
          async ({ userId, sessionHeaders }) => {
            const resource = resources.find((item) => item.kind === kind)!;
            const lookup = async (search: string, id = resource.shortId, credential = sessionHeaders) => {
              const query = new URLSearchParams({
                search,
                target_type: `core.ai.${kind}`,
                target_id: id,
                kinds: "service_account",
                service_account_kinds: "code",
              });
              const response = await api.request(`/accounts/entities?${query}`, { headers: credential });
              expect(response.status).toBe(200);
              return EntityListItemSchema.array().parse((await response.json()).items);
            };
            expect(await lookup(handle)).toEqual([]);
            expect(await lookup(handle, resource.shortId, adminHeaders)).toMatchObject([
              { kind: "service_account", serviceAccount: { id: accountId, handle, kind: "code" } },
            ]);
            expect(await lookup(handle, "absent", adminHeaders)).toEqual([]);
            const service = kind === "skill" ? aiSkills : aiProjects;
            const entry = await service.admin.grantAccess(resource.id, { principal: { type: "user", userId }, permission: "read" });
            expect(entry).not.toBeNull();
            expect(await lookup(handle)).toEqual([]);
            await service.admin.updateAccess(resource.id, entry!.id, "write");
            expect(await lookup(handle)).toEqual([]);
            await service.admin.updateAccess(resource.id, entry!.id, "admin");
            expect(await lookup("Code von Lookup fixture")).toEqual([]);
            expect(await lookup("code-0000000000")).toEqual([]);
            expect(await lookup("code-7k2")).toEqual([]);
            expect(await lookup(handle, "absent")).toEqual([]);
            expect(await lookup(handle)).toMatchObject([
              { kind: "service_account", serviceAccount: { id: accountId, handle, kind: "code" } },
            ]);
            // Exercise A1 through the real Administration save route, then reload the stored grant.
            const accessPath = `/admin/core/ai-${kind}s/${resource.shortId}/access`;
            const grant = await api.request(accessPath, {
              method: "POST",
              headers: { ...adminHeaders, "content-type": "application/json" },
              body: JSON.stringify({ principal: { type: "service_account", serviceAccountId: accountId }, permission: "read" }),
            });
            expect(grant.status).toBe(201);
            const stored = await api.request(accessPath, { headers: adminHeaders });
            expect(stored.status).toBe(200);
            expect((await stored.json()).access).toContainEqual(
              expect.objectContaining({
                principal: { type: "service_account", serviceAccountId: accountId },
                permission: "read",
                serviceAccountKind: "code",
                displayName: "Code of Lookup fixture",
              }),
            );
            const localized = await api.request(accessPath, { headers: { ...adminHeaders, "x-cloud-locale": "de" } });
            expect(localized.status).toBe(200);
            expect((await localized.json()).access).toContainEqual(
              expect.objectContaining({ displayName: "Code von Lookup fixture", serviceAccountKind: "code" }),
            );
          },
          { admin: false },
        );
      });
    });
  }
});
