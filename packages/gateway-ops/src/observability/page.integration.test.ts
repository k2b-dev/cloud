import { expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "observability-overview-meter-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const dbTest = testFor("database");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: "admin@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

/**
 * The statements of one warm SSR load of the operations overview. The area's shared reads (the health, the services'
 * states) answer from their 30 s caches and are measured where they live; the shell's rail is stubbed, as it belongs
 * to the platform. What stays: seven reads of the page, issued once each in one `Promise.all` (the telemetry overview,
 * its time series and failing routes, the log summary and time series, the job statistics), each in its own read-only
 * transaction of six framing statements (BEGIN, two SET LOCAL, SET TRANSACTION, the backend check, COMMIT), plus the
 * layout's screen preference: 7 × 6 + 7 + 1 = 50. Nothing repeats per app or per route; adding a read changes this on
 * purpose.
 */
const OVERVIEW_STATEMENTS = 50;
const OVERVIEW_QUERIES = 8;
const FRAMING = /^(BEGIN|COMMIT|ROLLBACK|SET |SELECT pid, extract\(epoch FROM backend_start\))/;

dbTest(
  "one warm load of the operations overview costs a fixed number of statements, none per app or route",
  async () => {
    const { default: handler } = await import("./page");
    const area = await import("./_components/ObservabilityArea");
    const infrastructure = await import("./infrastructure/sections");
    // the area's shared reads are measured where they live; here they answer from their caches
    const shared = [
      spyOn(area, "readHealth").mockResolvedValue({ status: "ok", apps: [] } as never),
      spyOn(infrastructure, "readInfraStates").mockResolvedValue({ postgres: "ok", valkey: "ok", nats: "ok" }),
    ];
    const rail = stubRailSnapshot();
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("runtime", { apps: [] });
      await next();
    });
    app.get("/admin/observability", ...handler);
    const load = async () => {
      const response = await app.request("/admin/observability", { headers: { "Accept-Language": "de" } });
      expect(response.status).toBe(200);
      await response.text();
    };
    const meter = await meterSql();
    try {
      await load();
      const statements = await meter.during(load);
      const queries = statements.filter((statement) => !FRAMING.test(statement));
      expect({ count: statements.length, queries: queries.length, statements }).toEqual({
        count: OVERVIEW_STATEMENTS,
        queries: OVERVIEW_QUERIES,
        statements: expect.any(Array),
      });
    } finally {
      await meter.close();
      rail.mockRestore();
      for (const spy of shared) spy.mockRestore();
    }
  },
  60_000,
);
