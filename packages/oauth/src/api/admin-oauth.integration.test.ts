import { expect, test } from "bun:test";
import { sql } from "bun";
import { z } from "zod";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import routes from "./index";

suiteFor(
  "database",
  "nats",
  "valkey",
)("oauth administrator OAuth ceiling", () => {
  test("every admin mutation rejects a real read-only administrator token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders);
    }));
  test("read-only OAuth cannot rotate a secret; write/admin OAuth and browser sessions can", () =>
    withAdminOAuth(async ({ readHeaders, writeHeaders, adminHeaders, sessionHeaders }) => {
      const [client] = await sql<{ id: string }[]>`
        INSERT INTO oauth.clients (name,client_id,redirect_uris,is_public,registration_kind,client_secret_hash)
        VALUES ('Scope fixture',${`scope-${crypto.randomUUID()}`},ARRAY[]::text[],false,'managed',${await Bun.password.hash("fixture")})
        RETURNING id
      `;
      const hash = async () => {
        const [row] = await sql<
          { client_secret_hash: string }[]
        >`SELECT client_secret_hash FROM oauth.clients WHERE id=${client!.id}::uuid`;
        return row!.client_secret_hash;
      };
      try {
        for (const headers of [writeHeaders, adminHeaders, sessionHeaders]) {
          const before = await hash();
          expect((await routes.request(`/${client!.id}/regenerate-secret`, { method: "POST", headers: readHeaders })).status).toBe(403);
          expect(await hash()).toBe(before);
          const response = await routes.request(`/${client!.id}/regenerate-secret`, { method: "POST", headers });
          expect(response.status).toBe(200);
          const { clientSecret } = z.object({ clientSecret: z.string() }).parse(await response.json());
          expect(await hash()).not.toBe(before);
          expect(await Bun.password.verify(clientSecret, await hash())).toBe(true);
        }
      } finally {
        await sql`DELETE FROM oauth.clients WHERE id=${client!.id}::uuid`;
      }
    }));
});
