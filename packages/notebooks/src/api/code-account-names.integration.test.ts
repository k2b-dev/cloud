import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import "../../../../scripts/fixtures/authorization-preload";
import cli from "../cli";
import api from ".";

suiteFor(
  "database",
  "nats",
  "valkey",
)("Notebook Code account names", () => {
  test("members get the type while managers and the CLI access route get the title snapshot", async () => {
    const notebook = { id: crypto.randomUUID(), shortId: testShortId() };
    const ownerId = crypto.randomUUID();
    const [manager, reader] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES (${`name-manager-${notebook.id}`},'local','user','Manager'),(${`name-reader-${notebook.id}`},'local','user','Reader') RETURNING id`;
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind,title)
      VALUES (${`code:demo.item:${ownerId}`},'code','Private title snapshot') RETURNING id`;
    try {
      await sql`INSERT INTO notebooks.notebooks(id,short_id,name) VALUES (${notebook.id}::uuid,${notebook.shortId},'Target')`;
      for (const [user, permission] of [
        [manager!, "admin"],
        [reader!, "read"],
      ] as const) {
        const [grant] = await sql<
          { id: string }[]
        >`INSERT INTO auth.access(user_id,permission) VALUES (${user.id}::uuid,${permission}) RETURNING id`;
        await sql`INSERT INTO notebooks.notebook_access(notebook_id,access_id) VALUES (${notebook.id}::uuid,${grant!.id}::uuid)`;
      }
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(service_account_id,permission) VALUES (${account!.id}::uuid,'read') RETURNING id`;
      await sql`INSERT INTO notebooks.notebook_access(notebook_id,access_id) VALUES (${notebook.id}::uuid,${grant!.id}::uuid)`;
      for (const [user, manage] of [
        [reader!, false],
        [manager!, true],
      ] as const) {
        const cookie = `session_token=${await createTestSession(user.id)}`;
        for (const suffix of manage ? ["/access/members", "/access"] : ["/access/members"]) {
          const response = await api.request(`/${notebook.shortId}${suffix}`, {
            headers: { cookie, "x-forwarded-for": uniqueCallerAddress(), "accept-language": "de" },
          });
          expect(response.status).toBe(200);
          const entries: { principal: { type: string; serviceAccountId?: string }; displayName?: string }[] = await response.json();
          const code = entries.find((entry) => entry.principal.serviceAccountId === account!.id);
          expect(code).toBeDefined();
          expect(JSON.stringify(code)).not.toContain(ownerId);
          expect(JSON.stringify(code)).not.toContain("code:demo.item:");
          if (manage) expect(code?.displayName).toContain("Private title snapshot");
          else {
            expect(code?.displayName).toBe("Code eines Objekts");
            expect(JSON.stringify(code)).not.toContain("Private title snapshot");
          }
        }
        if (manage) {
          let rows: Record<string, unknown>[] = [];
          const ctx: CloudCliContext = {
            args: ["access", "list", notebook.shortId],
            flags: { "include-service-accounts": true },
            options: { profile: "test", server: "https://cloud.example", token: "test", output: "text", locale: "de" },
            getDefault: async () => undefined,
            setDefault: async () => {},
            createApiClient: () => {
              throw new Error("Unused by this command");
            },
            fetch: async (path, init) =>
              api.request(path.replace(/^\/api\/notebooks/, "") || "/", {
                ...init,
                headers: {
                  ...Object.fromEntries(new Headers(init?.headers)),
                  cookie,
                  "x-forwarded-for": uniqueCallerAddress(),
                  "x-cloud-locale": "de",
                },
              }),
            readJson: async (response) => {
              if (!response.ok) throw new Error(`CLI request failed: ${response.status}`);
              return response.json();
            },
            print: () => {},
            write: async () => {},
            error: () => {},
            json: () => {},
            jsonLine: () => {},
            table: (value) => {
              rows = value;
            },
          };
          await cli.run(ctx);
          expect(rows).toContainEqual(expect.objectContaining({ principal: "Code von Private title snapshot" }));
          const output = JSON.stringify(rows);
          expect(output).not.toContain(ownerId);
          expect(output).not.toContain("code:demo.item:");
        }
      }
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id=${notebook.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id=${account!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${manager!.id}::uuid,${reader!.id}::uuid)`;
    }
  });
});
