import { runtimeCapabilities, RuntimeCapabilityRequest } from "./capability-runtime";
import { artifactAdmin, adminIdentity } from "./admin";
import { type AuthContext, auth, getLocale, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ArtifactKind, ArtifactMetadata, PublicationNote, ArtifactCreate, ArtifactFile, ArtifactSource, ArtifactUpdate, LIMITS } from "./contracts";
import { artifactDatabase, DatabaseError } from "./database";
import { DatabaseRequest, DatabaseSettings } from "./database-contracts";
import { StorageRequest } from "./storage-contracts";
import { artifacts, ArtifactError } from "./service";
import { artifactMessages } from "./messages";
import { compilationDiagnostic, compileArtifact } from "./runtime/compile";
import { cliHostBundle } from "./runtime/cli-bundle";
import { ClientCall, ClientCallResult, clientCalls } from "./client-calls";

const capabilityCaller=(c:Context<AuthContext>)=>({authorization:c.req.header("authorization"),cookie:c.req.header("cookie"),locale:getLocale(c),signal:c.req.raw.signal});
const identity = (c: Context<AuthContext>) => ({ actor: c.get("actor"), accessSubject: c.get("accessSubject"), conversationId: c.req.query("conversationId") });
const id = (c: Context<AuthContext>) => z.uuid().parse(c.req.param("id"));
const page = (c: Context<AuthContext>) => z.coerce.number().int().min(1).max(100000).parse(c.req.query("page") ?? 1);
const revision = (c: Context<AuthContext>) => c.req.query("revision") === undefined ? undefined
  : z.coerce.number().int().positive().parse(c.req.query("revision"));
const Level = z.enum(["read", "admin"]);
const PageQuery = z.object({ page: z.string().optional(), kind: ArtifactKind.optional(), q:z.string().max(120).optional(), conversationId: z.string().max(80).optional() });
const RevisionQuery = z.object({ conversationId: z.string().max(80).optional(), version: z.string().optional(), revision: z.string().optional(), published: z.enum(["true"]).optional() });
const Grant = z.object({
  principal: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), userId: z.uuid() }),
    z.object({ type: z.literal("group"), groupId: z.uuid() }),
    z.object({ type: z.literal("authenticated") }),
  ]),
  permission: Level,
}).strict();

export const artifactApi = new Hono<AuthContext>()
  .use("*", auth.requireRole("authenticated"))
  .use("*", auth.requireUser())
  .use("*", bodyLimit({ maxSize: LIMITS.rpcBytes }))
  .use("*", async (c,next) => { c.header("Cache-Control","private, no-store"); await next(); })
  .onError((error,c) => {
    if (error instanceof DatabaseError) {
      const t=artifactMessages.resolve([getLocale(c)]).t;
      const message=error.code === "DB_UNREACHABLE" ? t.DB_UNREACHABLE : error.code === "DB_TIMEOUT" ? t.DB_TIMEOUT : error.code === "DB_AUTH_FAILED" ? t.DB_AUTH_FAILED : error.code === "DB_NOT_CONFIGURED" ? t.DB_NOT_CONFIGURED : error.code === "DB_NOT_CONNECTED" ? t.DB_NOT_CONNECTED : error.code === "DB_SERVER_IN_USE" ? t.DB_SERVER_IN_USE : error.code;
      return respond(c,{ok:false,code:error.code,status:error.status,error:message});
    }
    const code = error instanceof ArtifactError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "REQUEST_FAILED";
    const status = code === "NOT_FOUND" ? 404 : code === "ACCESS_DENIED" ? 403
      : code === "CONFLICT" || code === "LAST_MANAGER" ? 409 : code === "REQUEST_FAILED" ? 500 : 400;
    if (code === "REQUEST_FAILED") console.error("Assistant artifact request failed", error);
    return respond(c,{ ok: false, code, status, error: artifactMessages.resolve([getLocale(c)]).t[code] });
  })
  .get("/", v("query", PageQuery), async (c) => respond(c,ok(await artifacts.list(identity(c),page(c),c.req.valid("query").kind,c.req.valid("query").q))))
  .get("/admin/resources",v("query",PageQuery.extend({search:z.string().max(120).optional()})),async c => respond(c,ok(await artifactAdmin.list(identity(c),page(c),c.req.valid("query").search))))
  .delete("/admin/resources/:id",async c => respond(c,ok(await artifactAdmin.remove(id(c),identity(c)))))
  .get("/admin/resources/:id/access",async c => respond(c,ok(await artifacts.access(id(c),adminIdentity(identity(c))))))
  .post("/admin/resources/:id/access",v("json",Grant),async c => respond(c,ok(await artifacts.grant(id(c),c.req.valid("json").principal,c.req.valid("json").permission,adminIdentity(identity(c))))))
  .put("/admin/resources/:id/access/:accessId",v("json",z.object({permission:Level.nullable()}).strict()),async c => respond(c,ok(await artifacts.changeGrant(id(c),z.uuid().parse(c.req.param("accessId")),c.req.valid("json").permission,adminIdentity(identity(c))))))
  .get("/admin/database/settings", async c => respond(c,ok(await artifactDatabase.settings(identity(c)))))
  .put("/admin/database/settings",v("json",DatabaseSettings),async c => respond(c,ok(await artifactDatabase.configure(c.req.valid("json"),identity(c)))))
  .post("/admin/database/test",v("json",DatabaseSettings),async c => respond(c,ok(await artifactDatabase.configure(c.req.valid("json"),identity(c),true))))
  .post("/:id/database/connect",async c => respond(c,ok(await artifactDatabase.connect(id(c),identity(c),c.req.raw.signal))))
  .post("/:id/database",v("json",DatabaseRequest),async c => respond(c,ok(await artifactDatabase.call(id(c),c.req.valid("json"),identity(c),c.req.raw.signal))))
  .post("/runtime/capabilities",v("json",RuntimeCapabilityRequest),async c=>respond(c,ok(await runtimeCapabilities.prepare(c.req.valid("json"),identity(c),capabilityCaller(c)))))
  .post("/runtime/capabilities/:callId/resolve",v("json",z.object({approved:z.boolean(),remember:z.literal("always").optional()}).strict()),async c=>respond(c,ok(await runtimeCapabilities.resolve(z.uuid().parse(c.req.param("callId")),c.req.valid("json"),identity(c),capabilityCaller(c)))))
  .get("/runtime/host.js", async c => c.body(await cliHostBundle(), 200, { "Content-Type": "application/javascript; charset=utf-8" }))
  .post("/runtime/claim", v("json", ClientCall), async (c) => respond(c, ok(await clientCalls.claim(c.req.valid("json"), identity(c)))))
  .post("/runtime/complete", v("json", ClientCallResult), async (c) => respond(c, ok(await clientCalls.complete(c.req.valid("json"), identity(c)))))
  .post("/", v("json",ArtifactCreate), async (c) => respond(c,ok(await artifacts.create(c.req.valid("json"),identity(c))),201))
  .post("/runtime/compile", v("json", ArtifactSource), async c => respond(c,ok(await compileArtifact(c.req.valid("json")))))
  .post("/validate", v("json",ArtifactSource), async (c) => {
    try { await compileArtifact(c.req.valid("json")); return respond(c,ok({ valid: true, diagnostics: [] })); }
    catch (error) { return respond(c,ok({ valid: false, diagnostics: [compilationDiagnostic(error)] })); }
  })
  .get("/:id", v("query", RevisionQuery), async (c) => respond(c,ok(await artifacts.get(id(c),identity(c),revision(c),c.req.query("published") === "true", c.req.query("version") === undefined ? undefined : z.coerce.number().int().positive().parse(c.req.query("version"))))))
  .post("/:id/publish", v("json", z.object({ expectedRevision: z.number().int().positive(), note: PublicationNote }).strict()), async c =>
    respond(c, ok(await artifacts.publish(id(c), c.req.valid("json").expectedRevision, identity(c), c.req.valid("json").note))))
  .get("/:id/versions", v("query", PageQuery), async c => respond(c,ok(await artifacts.versions(id(c),identity(c),page(c)))))
  .post("/:id/restore", v("json", z.object({version:z.number().int().positive(),expectedRevision:z.number().int().positive()}).strict()), async c => respond(c,ok(await artifacts.restore(id(c),c.req.valid("json").version,c.req.valid("json").expectedRevision,identity(c)))))
  .patch("/:id/metadata", v("json", ArtifactMetadata), async c => respond(c,ok(await artifacts.metadata(id(c),c.req.valid("json"),identity(c)))))
  .post("/:id/unpublish", async c => respond(c, ok(await artifacts.unpublish(id(c), identity(c)))))
  .post("/:id/fork", async c => respond(c, ok(await artifacts.fork(id(c), identity(c))), 201))
  .post("/:id/edit-chat", async c => respond(c, ok(await artifacts.editChat(id(c), identity(c))), 201))
  .put("/:id/files",v("json",ArtifactFile),async c=>respond(c,ok(await artifacts.writeFile(id(c),c.req.valid("json").path,c.req.valid("json").content,identity(c)))))
  .put("/:id", v("json",ArtifactUpdate), async (c) => respond(c,ok(await artifacts.update(id(c),c.req.valid("json"),identity(c)))))
  .get("/:id/revisions", async (c) => respond(c,ok(await artifacts.history(id(c),identity(c),page(c)))))
  .get("/:id/compiled", v("query", RevisionQuery), async (c) => {
    const bundle = await artifacts.get(id(c),identity(c),revision(c));
    try { return respond(c,ok({ ...await compileArtifact(bundle.source), revision: bundle.sourceRevision })); }
    catch (error) { return respond(c,{ ok: false, status: 400, code: "COMPILE_FAILED", error: compilationDiagnostic(error) }); }
  })
  .post("/:id/storage", v("query",z.object({conversationId:z.string().max(80).optional()})), v("json",StorageRequest), async c => respond(c,ok(await artifacts.storage(id(c),c.req.valid("json"),identity(c)))))
  .get("/:id/projects", async c => respond(c,ok(await artifacts.projects(id(c),identity(c)))))
  .put("/:id/projects/:projectId", v("json",z.object({linked:z.boolean()}).strict()), async c => respond(c,ok(await artifacts.linkProject(id(c),z.string().min(1).max(80).parse(c.req.param("projectId")),c.req.valid("json").linked,identity(c)))))
  .get("/:id/access", async (c) => respond(c,ok(await artifacts.access(id(c),identity(c)))))
  .post("/:id/access", v("json",Grant), async (c) => {
    const input = c.req.valid("json");
    return respond(c,ok(await artifacts.grant(id(c),input.principal,input.permission,identity(c))));
  })
  .put("/:id/access/:accessId", v("json",z.object({ permission: Level.nullable() }).strict()), async (c) =>
    respond(c,ok(await artifacts.changeGrant(id(c),z.uuid().parse(c.req.param("accessId")),c.req.valid("json").permission,identity(c)))));
