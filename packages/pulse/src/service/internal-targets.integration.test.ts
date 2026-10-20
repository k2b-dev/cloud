import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { addInternalTarget, removeInternalTarget } from "./base-admin";
import { requestMetrics } from "./metrics-http";
import { baseScrapeAllowlist, checkScrapeTarget } from "./scrape-target";

databaseSuite()("Pulse per-base internal targets", () => {
  beforeAll(migrate);
  test("rechecks releases on save, every redirect and the next scrape after revocation", async () => {
    const baseId = crypto.randomUUID(),
      shortId = newShortId();
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`targets-${baseId}`},'local','user','Targets fixture') RETURNING id`;
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${shortId},'Targets fixture')`;
    const identity = adminFixtureIdentity(user!.id);
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/redirect") return Response.redirect(`http://localhost:${url.port}/metrics`);
          if (url.pathname === "/loop") return Response.redirect(`${url.origin}/loop`);
          return new Response("fixture_gauge 1\n");
        },
      });
      const port = server.port;
      if (!port) throw new Error("MISSING_TEST_PORT");
      const endpoint = `${server.url.origin}/metrics`,
        readAllowlist = () => baseScrapeAllowlist(baseId);
      expect(await checkScrapeTarget(endpoint, baseId)).toMatchObject({ ok: false, error: { code: "PULSE_SCRAPE_TARGET_BLOCKED" } });
      expect(await requestMetrics(endpoint, undefined, 2000, { readAllowlist })).toMatchObject({
        ok: false,
        error: { code: "PULSE_SCRAPE_TARGET_BLOCKED" },
      });
      for (const entry of ["metrics.internal", "10.20.0.0/16"]) {
        const target = await addInternalTarget(identity, { baseId: shortId, entry });
        expect(target.entry).toBe(entry);
        await removeInternalTarget(identity, target.id);
      }
      await expect(addInternalTarget(identity, { baseId: shortId, entry: "0.0.0.0/0" })).rejects.toMatchObject({
        code: "TARGET_TOO_BROAD",
        status: 400,
      });
      const released = await addInternalTarget(identity, { baseId: shortId, entry: `127.0.0.1:${port}` });
      await expect(addInternalTarget(identity, { baseId: shortId, entry: released.entry })).rejects.toMatchObject({
        code: "TARGET_EXISTS",
        status: 409,
      });
      expect((await checkScrapeTarget(endpoint, baseId)).ok).toBe(true);
      expect((await requestMetrics(endpoint, undefined, 2000, { readAllowlist })).ok).toBe(true);
      expect((await checkScrapeTarget(`http://127.0.0.1:${port === 65535 ? 65534 : port + 1}/metrics`, baseId)).ok).toBe(false);
      expect(await requestMetrics(`${server.url.origin}/redirect`, undefined, 2000, { readAllowlist })).toMatchObject({
        ok: false,
        error: { code: "PULSE_SCRAPE_TARGET_BLOCKED" },
      });
      expect(await requestMetrics(`${server.url.origin}/loop`, undefined, 2000, { readAllowlist })).toMatchObject({
        ok: false,
        error: { message: "Metrics endpoint exceeded the 3 redirect limit" },
      });
      await removeInternalTarget(identity, released.id);
      const revoked = await requestMetrics(endpoint, undefined, 2000, { readAllowlist });
      expect(revoked).toMatchObject({ ok: false, error: { code: "PULSE_SCRAPE_TARGET_BLOCKED" } });
      if (!revoked.ok) expect(revoked.error.message).toContain("127.0.0.1 is an internal server and not released for this base");
    } finally {
      await server?.stop(true);
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  });
});
