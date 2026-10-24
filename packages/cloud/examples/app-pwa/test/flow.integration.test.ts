import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { invalidateIdentityRuntimeConfig } from "../../../src/services/identity/runtime-config";
import { createTestSession } from "../../../src/services/session/session.test-fixture";
import * as settings from "../../../src/services/settings";
import { SUBJECT_ID } from "../src/constants";
import { setupDomain } from "../src/domain";
import { createExamplePwa } from "../src/platform";

const origin = "https://cloud.example.test";
const owner = "cf110000-0000-4000-8000-000000000001";
const pwa = createExamplePwa(origin);
const csrfBody = z.object({ csrf: z.string() });
const issued = z.object({ id: z.uuid(), qr: z.string() });
const signature = {
  kind: "typed",
  name: "Lea Muster",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 264 77" width="264" height="77"><text x="12" y="55" font-family="cursive" font-size="48" fill="currentColor">Lea Muster</text></svg>',
};

suiteFor(
  "database",
  "nats",
  "valkey",
)("example signatures through real Core identity and App-PWA sessions", () => {
  let token: string;
  let previousUrl: string;
  let previousRate: number;
  beforeAll(async () => {
    previousUrl = await settings.get<string>("app.url");
    previousRate = await settings.get<number>("security.rate_limit_per_second");
    await settings.set("app.url", origin);
    await settings.set("security.rate_limit_per_second", 10000);
    invalidateIdentityRuntimeConfig();
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,'app-pwa-example-flow','local','user')`;
    token = await createTestSession(owner);
    await setupDomain();
    await pwa.setup();
  });
  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS visit_demo CASCADE`;
    await sql`DELETE FROM auth.users WHERE id=${owner}::uuid`;
    if (previousUrl !== undefined) await settings.set("app.url", previousUrl);
    if (previousRate !== undefined) await settings.set("security.rate_limit_per_second", previousRate);
    invalidateIdentityRuntimeConfig();
  });
  const post = (route: string, body: unknown, cookie?: string, csrf?: string) =>
    pwa.router.fetch(
      new Request(`${origin}${route}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(csrf ? { "X-App-Pwa-CSRF": csrf } : {}) },
        body: JSON.stringify(body),
      }),
    );
  const json = async (response: Response) => {
    expect(response.status).toBe(200);
    return response.json();
  };

  test("a paired customer signs both offered documents and completion commits their signatures once", async () => {
    const staff = pwa.router.staffApiPath;
    const guest = pwa.router.guestApiPath;
    const employee = `session_token=${token}`;
    const staffCsrf = csrfBody.parse(await json(await post(`${staff}/bootstrap`, {}, employee))).csrf;
    const boot = await post(`${guest}/bootstrap`, {});
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const csrf = csrfBody.parse(await json(boot)).csrf;
    const device = issued.parse(
      await json(await post(`${staff}/devices/issue`, { requestId: crypto.randomUUID(), name: "Laden-iPad" }, employee, staffCsrf)),
    );
    await json(await post(`${guest}/device/claim`, { qr: device.qr }, cookie, csrf));
    const visit = issued.parse(
      await json(
        await post(
          `${staff}/visits/issue`,
          { requestId: crypto.randomUUID(), deviceId: device.id, subject: { customerId: SUBJECT_ID } },
          employee,
          staffCsrf,
        ),
      ),
    );
    await json(await post(`${guest}/visit/claim`, { qr: visit.qr }, cookie, csrf));
    for (const documentId of ["contract", "receipt"]) {
      const command = { visitId: visit.id, attemptId: crypto.randomUUID(), input: { documentId, revision: 1, signature, consent: true } };
      const result = await json(await post(`${guest}/command/sign-${documentId}`, command, cookie, csrf));
      expect(result.completed).toBe(documentId === "receipt");
      const replay = await json(await post(`${guest}/command/sign-${documentId}`, command, cookie, csrf));
      expect(replay.replayed).toBe(true);
    }
    const [count] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM visit_demo.signatures WHERE visit_id=${visit.id}::uuid`;
    expect(count?.count).toBe(2);
    const [visitState] = await sql<{ state: string }[]>`SELECT state FROM visit_demo._cloud_pwa_visits WHERE id=${visit.id}::uuid`;
    expect(visitState?.state).toBe("ended");
    expect((await post(`${guest}/query/document`, { visitId: visit.id, input: {} }, cookie, csrf)).status).toBe(410);
  });
});
