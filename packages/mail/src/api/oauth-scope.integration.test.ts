import { expect, test } from "bun:test";
import { sql } from "bun";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth, withPersonalApiKey } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import routes from "./index";

suiteFor(
  "database",
  "nats",
  "valkey",
)("mail resource OAuth ceiling", () => {
  test("every protected mutation rejects a real read-only user OAuth token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders, (path) => !path.startsWith("/admin/"));
    }));
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("Mail ordinary user credential ceiling", () => {
  test("read OAuth cannot change a mailbox; read-only POST, browser and personal keys retain access", () =>
    withAdminOAuth(
      async ({ userId, readHeaders, writeHeaders, adminHeaders, sessionHeaders }) => {
        const name = `OAuth mailbox ${crypto.randomUUID()}`;
        const created = await routes.request("/mailboxes", {
          method: "POST",
          headers: { ...writeHeaders, "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        expect(created.status).toBe(200);
        const [mailbox] = await sql<{ id: string; short_id: string }[]>`SELECT id,short_id FROM mail.mailboxes WHERE name=${name}`;
        expect(mailbox).toBeDefined();
        const path = `/mailboxes/${mailbox!.short_id}`;
        const patch = (headers: Record<string, string>, nextName: string) =>
          routes.request(path, {
            method: "PATCH",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ name: nextName }),
          });
        try {
          expect((await routes.request(path, { headers: readHeaders })).status).toBe(200);
          await withPersonalApiKey(userId, async (keyHeaders) => {
            for (const [index, headers] of [writeHeaders, adminHeaders, sessionHeaders, keyHeaders].entries()) {
              const [before] = await sql<{ name: string }[]>`SELECT name FROM mail.mailboxes WHERE id=${mailbox!.id}::uuid`;
              expect((await patch(readHeaders, "Rejected")).status).toBe(403);
              const [after] = await sql<{ name: string }[]>`SELECT name FROM mail.mailboxes WHERE id=${mailbox!.id}::uuid`;
              expect(after!.name).toBe(before!.name);
              expect((await patch(headers, `Allowed ${index}`)).status).toBe(200);
            }
          });
          const outcomes = await routes.request(`${path}/commands/outcomes`, {
            method: "POST",
            headers: { ...readHeaders, "content-type": "application/json" },
            body: JSON.stringify({ commandIds: ["11111111-1111-4111-8111-111111111111"] }),
          });
          expect(outcomes.status).toBe(200);
        } finally {
          await sql`DELETE FROM mail.mailboxes WHERE id=${mailbox!.id}::uuid`;
        }
      },
      { admin: false },
    ));
});
