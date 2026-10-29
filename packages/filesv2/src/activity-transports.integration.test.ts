import { afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import * as cloudServer from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { hc } from "hono/client";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { actorId, baseId, historyBinding, historyFixture, home, otherId, publicBaseId } from "../test/activity-reader-fixture";
import { testActor, testCall } from "../test/files-call";
import { assertPrivateDatabase } from "../test/private-database";
import type { ActivityPage } from "./activity-contracts";
import { activityReaderData } from "./data/activity-reader";
import { bindings } from "./data/bases";
import { migrate } from "./migrate";
import { filesService } from "./service";
import { createActivityReader } from "./service/activity-reader";

// Authentication is transport setup only. Every payload below goes through the actual reader and SQL projection.
const pass: MiddlewareHandler = async (_c, next) => next();
mock.module("@k2b/cloud/server", () => ({ ...cloudServer, auth: { ...cloudServer.auth, requireRole: () => pass }, rateLimit: () => pass }));
const { default: routes } = await import("./api");
const { filesCapabilities } = await import("./capabilities");
const { default: filesCli } = await import("./cli");
const app = new Hono<cloudServer.AuthContext>()
  .use("*", async (c, next) => {
    c.set("actor", testActor);
    c.set("accessSubject", testCall(testActor).accessSubject);
    c.set("credentialKind", "session");
    await next();
  })
  .route("/api/filesv2", routes);
const context: CapabilityExecutionContext = {
  actor: testActor,
  accessSubject: testCall(testActor).accessSubject,
  user: testActor.kind === "user" ? testActor.user : null,
  locale: "en",
  requestId: "history-transport-integration",
  origin: "assistant",
  signal: new AbortController().signal,
};
const eventId = "40000000-0000-4000-8000-000000000001";
suiteFor("database")("history projection through API, CLI and Assistant", () => {
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY,uid text,display_name text,avatar_hash text)`.simple();
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY)`.simple();
    await migrate();
  });
  beforeEach(async () => {
    await sql`TRUNCATE auth.users,filesv2.bases CASCADE`.simple();
    await sql`INSERT INTO auth.users(id,uid,display_name) VALUES(${actorId}::uuid,'alice','Alice'),(${otherId}::uuid,'bob','Bob')`;
    await sql`INSERT INTO filesv2.bases ${sql(historyBinding)}`;
    await sql`INSERT INTO filesv2.activity(id,action,state,server_url,root,base_id,directory,name,path_before,path_after,item_id,item_after_id,actor_kind,actor_user_id,via,started_at,finished_at,detail)
      VALUES(${eventId}::uuid,'item.move','done','http://filegate.test','cloud',${baseId}::uuid,true,'old',${home + "/old"},${home + "/new"},'stable-a','stable-a','user',${otherId}::uuid,'api','2030-05-15T12:00:00Z','2030-05-15T12:00:00Z','{"token":"must-not-escape"}')`;
  });
  afterEach(() => {
    spyOn(filesService, "activity").mockRestore();
    spyOn(filesService, "movementChain").mockRestore();
  });
  function fixture() {
    const f = historyFixture();
    const reader = createActivityReader({ ...f.deps, data: activityReaderData, bindings, displayNames: cloudServer.resolveDisplayNames });
    spyOn(filesService, "activity").mockImplementation(reader.activity);
    spyOn(filesService, "movementChain").mockImplementation(reader.movementChain);
    return f;
  }
  const apiPage = async (): Promise<ActivityPage> => {
    const response = await app.request("http://cloud.test/api/filesv2/activity");
    expect(response.status).toBe(200);
    return response.json();
  };
  test("POSIX area returns a stable unavailable code through the API", async () => {
    fixture();
    const response = await app.request(`http://cloud.test/api/filesv2/activity?baseId=freeipa:users:${actorId}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "history_unavailable" });
  });
  test("all three surfaces return the same authorized projection and react to lost current membership", async () => {
    const f = fixture();
    const page = await apiPage();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.before).toEqual({
      visibility: "disappearance",
      name: "old",
      path: `${home}/old`,
      relativePath: "old",
      directory: true,
      publicBaseId,
    });
    expect(page.items[0]?.after.visibility).toBe("full");
    expect(JSON.stringify(page)).not.toContain("must-not-escape");
    const capability = await filesCapabilities.queries["activity.list"].run({}, context);
    expect(capability).toEqual({ ok: true, data: { data: page } });
    const lines: string[] = [];
    const ctx: CloudCliContext = {
      args: ["history"],
      flags: {},
      options: { profile: "test", server: "http://cloud.test", token: "test", output: "json" },
      createApiClient: ((base: string) =>
        hc(`http://cloud.test${base}`, {
          fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => app.request(input, init),
        })) as CloudCliContext["createApiClient"],
      fetch: async () => {
        throw new Error("Unexpected untyped fetch");
      },
      readJson: async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      },
      getDefault: async () => undefined,
      setDefault: async () => {},
      print: () => {},
      error: () => {},
      write: async () => {},
      table: () => {},
      json: (value) => void lines.push(JSON.stringify(value)),
      jsonLine: () => {},
    };
    await filesCli.run(ctx);
    expect(JSON.parse(lines[0]!)).toEqual(page);
    f.setMember(false);
    expect((await apiPage()).items).toEqual([]);
    const after = await filesCapabilities.queries["activity.list"].run({}, context);
    expect(after).toMatchObject({ ok: true, data: { data: { items: [], visibleCount: 0 } } });
  });
  test("HTTP descendant chains use SQL movement evidence and fresh child access without resolving the ancestor", async () => {
    const f = fixture();
    f.nodes.set(`${home}/new/child.txt`, f.node(`${home}/new/child.txt`, "child-id", false));
    const url = `http://cloud.test/api/filesv2/activity/${eventId}/chain?oldPath=old%2Fchild.txt`;
    const response = await app.request(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      endpoint: { baseId: publicBaseId, path: "new/child.txt", itemId: null },
      certainty: "probable",
      truncated: false,
      historyComplete: false,
    });
    expect(f.authorized).toContain("new/child.txt");
    expect(f.requests.some((request) => request.includes("resolve"))).toBe(false);
    f.denied.add("new/child.txt");
    const denied = await app.request(url);
    expect(denied.status).toBe(200);
    expect(await denied.json()).toMatchObject({ endpoint: null, certainty: "unavailable" });
    expect((await app.request(`http://cloud.test/api/filesv2/activity/${eventId}/chain?oldPath=older%2Fchild.txt`)).status).toBe(404);
  });
  test("a hidden chain source returns HTTP and capability 404 rather than a path or an empty success", async () => {
    const f = fixture();
    f.setMember(false);
    const response = await app.request(`http://cloud.test/api/filesv2/activity/${eventId}/chain`);
    expect(response.status).toBe(404);
    expect(await filesCapabilities.queries["activity.chain"].run({ activityId: eventId }, context)).toMatchObject({
      ok: false,
      error: { status: 404 },
    });
  });
});
