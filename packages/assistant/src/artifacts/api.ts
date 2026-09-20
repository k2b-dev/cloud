import { chatPresentations } from "./chat-presentations";
import { ChatPresentationInput } from "./chat-presentation-contracts";
import { studioFiles } from "./file-transfer";
import { AiFileWriteError, CODE_SOURCE_TOOLS } from "@k2b/cloud/ai";
import { GotenbergRenderError } from "@k2b/cloud/services";
import { studioPdf } from "./pdf-service";
import { decodePdfRequest } from "./pdf-contracts";
import type { CapabilityCaller } from "@k2b/cloud/capabilities/server";
import { CodeResourceId } from "@k2b/cloud/ai/browser";
import { httpService, HttpError } from "./http-service";
import { HttpScope, SecretSave, HttpPrepare } from "./http-contracts";
import { runtimeCapabilities, RuntimeCapabilityRequest } from "./capability-runtime";
import { artifactAdmin, adminIdentity } from "./admin";
import { type AuthContext, auth, getLocale, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ArtifactMetadata, PublicationNote, ArtifactCreate, ArtifactFile, ArtifactSource, ArtifactUpdate, LIMITS } from "./contracts";
import { artifactDatabase, DatabaseError } from "./database";
import { DatabaseRequest, DatabaseSettings } from "./database-contracts";
import { StorageJsonRequest, StorageFileQuery, STORAGE_TRANSPORT_BYTES } from "./storage-contracts";
import { storageSettings, StorageSettings } from "./storage-settings";
import { artifacts, ArtifactError } from "./service";
import { artifactMessages } from "./messages";
import { compilationDiagnostic, compileArtifact } from "./runtime/compile";
import { ArtifactCompileError, sourceActions, actionValidator } from "./actions";
import { CodeActionInput } from "@k2b/cloud/ai/browser";
import { cliHostBundle } from "./runtime/cli-bundle";
import { renameSource } from "./rename-source";
import { ClientCall, ClientCallResult, clientCalls } from "./client-calls";

const capabilityCaller=(c:Context<AuthContext>)=>({authorization:c.req.header("authorization"),cookie:c.req.header("cookie"),locale:getLocale(c),signal:c.req.raw.signal});
const identity = (c: Context<AuthContext>) => ({ actor: c.get("actor"), accessSubject: c.get("accessSubject"), conversationId: c.req.query("conversationId") });
const id = (c: Context<AuthContext>) => CodeResourceId.parse(c.req.param("id"));
const page = (c: Context<AuthContext>) => z.coerce.number().int().min(1).max(100000).parse(c.req.query("page") ?? 1);
const revision = (c: Context<AuthContext>) => c.req.query("revision") === undefined ? undefined
  : z.coerce.number().int().positive().parse(c.req.query("revision"));
const Level = z.enum(["read", "admin"]);
const PageQuery = z.object({ page: z.string().optional(), q:z.string().max(120).optional(), conversationId: z.string().max(80).optional() });
const RevisionQuery = z.object({ conversationId: z.string().max(80).optional(), version: z.string().optional(), revision: z.string().optional(), published: z.enum(["true"]).optional() });
const Grant = z.object({
  principal: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), userId: z.uuid() }),
    z.object({ type: z.literal("group"), groupId: z.uuid() }),
    z.object({ type: z.literal("authenticated") }),
    z.object({ type: z.literal("public") }),
  ]),
  permission: Level,
}).strict().refine(value => value.principal.type !== "public" || value.permission === "read", "Public access only supports read");

export const createArtifactServiceRoutes = (caller: (context: Context<AuthContext>) => CapabilityCaller = capabilityCaller) => new Hono<AuthContext>()
  .use("*", (c,next) => (c.req.path.endsWith("/storage/file") || c.req.path.endsWith("/runtime/pdf")) ? next() : bodyLimit({ maxSize: c.req.path.includes("/storage") ? STORAGE_TRANSPORT_BYTES : LIMITS.rpcBytes })(c,next))
  .use("*", async (c,next) => { c.header("Cache-Control","private, no-store"); await next(); })
  .onError((error,c) => {
    if (error instanceof ArtifactCompileError || error instanceof AiFileWriteError)
      return respond(c, { ok: false, code: error.code, status: error.code === "CONFLICT" ? 409 : 400, error: error.message });
    if (error instanceof GotenbergRenderError) {
      const code = error.code === "not_configured" ? "PDF_NOT_CONFIGURED" : error.code === "timeout" ? "PDF_TIMEOUT"
        : error.code === "html_too_large" || error.code === "pdf_too_large" ? "PDF_LIMIT" : error.code === "bad_input" ? "INVALID_INPUT" : "PDF_FAILED";
      return respond(c, { ok: false, code, status: code === "PDF_LIMIT" ? 413 : code === "INVALID_INPUT" ? 400 : 503, error: artifactMessages.resolve([getLocale(c)]).t[code] });
    }
    if (error instanceof HttpError) {
      const t = artifactMessages.resolve([getLocale(c)]).t;
      return respond(c, { ok: false, code: error.code, status: error.code === "HTTP_DENIED" ? 403 : 409, error: t[error.code] });
    }
    if (error instanceof DatabaseError) {
      const t=artifactMessages.resolve([getLocale(c)]).t;
      const message=error.code === "DB_SQL_UNSUPPORTED" ? t.DB_SQL_UNSUPPORTED : error.code === "DB_SQL_PARAMS" ? t.DB_SQL_PARAMS : error.code === "DB_LIMIT" ? t.DB_LIMIT : error.code === "CONFLICT" ? t.DB_CHANGED : error.code === "DB_UNREACHABLE" ? t.DB_UNREACHABLE : error.code === "DB_TIMEOUT" ? t.DB_TIMEOUT : error.code === "DB_AUTH_FAILED" ? t.DB_AUTH_FAILED : error.code === "DB_NOT_CONFIGURED" ? t.DB_NOT_CONFIGURED : error.code === "DB_NOT_CONNECTED" ? t.DB_NOT_CONNECTED : error.code === "DB_SERVER_IN_USE" ? t.DB_SERVER_IN_USE : error.code;
      return respond(c,{ok:false,code:error.code,status:error.status,error:message});
    }
    const code = error instanceof ArtifactError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "REQUEST_FAILED";
    const status = code === "TOO_MANY_REQUESTS" ? 429 : code === "NOT_FOUND" ? 404 : code === "ACCESS_DENIED" ? 403
      : code === "CONFLICT" || code === "LAST_MANAGER" ? 409 : code === "REQUEST_FAILED" ? 500 : 400;
    if (code === "REQUEST_FAILED") console.error("Assistant artifact request failed", error);
    return respond(c,{ ok: false, code, status, error: artifactMessages.resolve([getLocale(c)]).t[code] });
  })
  .post("/presentations", v("json", ChatPresentationInput), async c => c.json(await chatPresentations.save(c.req.valid("json"), identity(c))))
  .get("/presentations/:presentationId", async c => c.json(await chatPresentations.read(z.uuid().parse(c.req.param("presentationId")), z.string().min(1).parse(c.req.query("conversationId")), identity(c))))
  .get("/presentations/:presentationId/input", async c => {
    const file = await chatPresentations.input(z.uuid().parse(c.req.param("presentationId")), z.string().min(1).parse(c.req.query("conversationId")), z.string().min(1).parse(c.req.query("path")), identity(c));
    return new Response(new Uint8Array(file.data), { headers: { "Content-Type": file.mediaType, "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } });
  })
  .post("/runtime/pdf", async (c,next) => {
    await studioPdf.authorize({ resourceId: c.req.query("resourceId"), conversationId: c.req.query("conversationId") }, identity(c));
    await next();
  }, bodyLimit({ maxSize: STORAGE_TRANSPORT_BYTES }), async c => {
    let input: ReturnType<typeof decodePdfRequest>;
    try { input = decodePdfRequest(await c.req.raw.formData()); }
    catch { throw new ArtifactError("INVALID_INPUT"); }
    const result = await studioPdf.execute(input, c.req.raw.signal);
    return new Response(new Uint8Array(result.pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="document.pdf"', "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  })
  .post("/runtime/secrets/list",v("json",HttpScope),async c=>respond(c,ok(await httpService.list(c.req.valid("json"),identity(c)))))
  .put("/runtime/secrets",v("json",z.object({scope:HttpScope,secret:SecretSave}).strict()),async c=>{const input=c.req.valid("json");return respond(c,ok(await httpService.save(input.scope,input.secret,identity(c))));})
  .post("/runtime/secrets/remove",v("json",z.object({scope:HttpScope,name:z.string(),revision:z.uuid()}).strict()),async c=>{const input=c.req.valid("json");return respond(c,ok(await httpService.remove(input.scope,input.name,input.revision,identity(c))));})
  .post("/runtime/http",v("json",HttpPrepare),async c=>respond(c,ok(await httpService.prepare(c.req.valid("json"),identity(c)))))
  .post("/runtime/http/:callId",v("json",z.object({approved:z.boolean()}).strict()),async c=>respond(c,ok(await httpService.execute(z.uuid().parse(c.req.param("callId")),c.req.valid("json").approved,identity(c),c.req.raw.signal))))
  .get("/project-links/:projectId", v("query", PageQuery.extend({ available: z.enum(["true","false"]).optional() })), async c =>
    respond(c,ok(await artifacts.projectApps(z.string().min(1).max(80).parse(c.req.param("projectId")),identity(c),page(c),c.req.valid("query").q,c.req.valid("query").available === "true"))))
  .get("/", v("query", PageQuery), async (c) => respond(c,ok(await artifacts.list(identity(c),page(c),c.req.valid("query").q))))
  .get("/admin/resources",v("query",PageQuery.extend({search:z.string().max(120).optional()})),async c => respond(c,ok(await artifactAdmin.list(identity(c),page(c),c.req.valid("query").search))))
  .delete("/admin/resources/:id",async c => respond(c,ok(await artifactAdmin.remove(id(c),identity(c)))))
  .get("/admin/resources/:id/projects",async c => respond(c,ok(await artifacts.projects(id(c),adminIdentity(identity(c))))))
  .get("/admin/resources/:id/access",async c => respond(c,ok(await artifacts.access(id(c),adminIdentity(identity(c))))))
  .post("/admin/resources/:id/access",v("json",Grant),async c => respond(c,ok(await artifacts.grant(id(c),c.req.valid("json").principal,c.req.valid("json").permission,adminIdentity(identity(c))))))
  .put("/admin/resources/:id/access/:accessId",v("json",z.object({permission:Level.nullable()}).strict()),async c => respond(c,ok(await artifacts.changeGrant(id(c),z.uuid().parse(c.req.param("accessId")),c.req.valid("json").permission,adminIdentity(identity(c))))))
  .get("/admin/storage/settings",async c=>respond(c,ok(await storageSettings.read(identity(c)))))
  .put("/admin/storage/settings",v("json",StorageSettings),async c=>respond(c,ok(await storageSettings.write(c.req.valid("json"),identity(c)))))
  .get("/admin/database/settings", async c => respond(c,ok(await artifactDatabase.settings(identity(c)))))
  .put("/admin/database/settings",v("json",DatabaseSettings),async c => respond(c,ok(await artifactDatabase.configure(c.req.valid("json"),identity(c)))))
  .post("/admin/database/test",v("json",DatabaseSettings),async c => respond(c,ok(await artifactDatabase.configure(c.req.valid("json"),identity(c),true))))
  .post("/:id/database/maintenance/connect",async c => respond(c,ok(await artifactDatabase.connect(id(c),identity(c),c.req.raw.signal,true))))
  .post("/:id/database/maintenance",v("json",DatabaseRequest),async c => respond(c,ok(await artifactDatabase.call(id(c),c.req.valid("json"),identity(c),c.req.raw.signal,"maintenance"))))
  .post("/:id/database/connect",async c => respond(c,ok(await artifactDatabase.connect(id(c),identity(c),c.req.raw.signal))))
  .post("/files/list",v("json",CODE_SOURCE_TOOLS.code_files.input),async c => {
    const input=c.req.valid("json");
    return respond(c,ok(await studioFiles.list(input,identity(c),input.after,input.limit)));
  })
  .post("/files/stat",v("json",CODE_SOURCE_TOOLS.code_file_stat.input),async c => {
    const file=await studioFiles.read(c.req.valid("json").file,identity(c));
    return respond(c,ok(file ? {exists:true,reference:file.reference,size:file.bytes.byteLength,mediaType:file.mediaType} : {exists:false}));
  })
  .post("/files/copy",v("json",CODE_SOURCE_TOOLS.code_file_copy.input.extend({confirmed:z.literal(true)})),async c => {
    const input=c.req.valid("json");
    return respond(c,ok(await studioFiles.copy(input.source,input.destination,input.expectedVersion,identity(c),c.req.raw.signal)));
  })
  .get("/:id/database/status",async c => respond(c,ok(await artifactDatabase.status(id(c),identity(c),c.req.raw.signal))))
  .post("/:id/database/clear",v("json",z.object({confirmed:z.literal(true),expectedGeneration:z.string().regex(/^[a-f0-9]{64}$/),expectedDataRevision:z.uuid()}).strict()),async c => {
    const input=c.req.valid("json");
    return respond(c,ok(await artifactDatabase.clear(id(c),input.expectedGeneration,input.expectedDataRevision,identity(c),c.req.raw.signal)));
  })
  .post("/:id/database/reset",v("json",z.object({confirmed:z.literal(true),expectedGeneration:z.string().length(64).nullable()}).strict()),async c => respond(c,ok(await artifactDatabase.reset(id(c),c.req.valid("json").expectedGeneration,identity(c)))))
  .get("/:id/database/export",async c => {
    const response = await artifactDatabase.export(id(c),identity(c),c.req.raw.signal);
    return new Response(response.body,{headers:{"Content-Type":"application/vnd.sqlite3","Content-Disposition":`attachment; filename="studio-${id(c)}.sqlite"`,"Cache-Control":"private, no-store"}});
  })
  .post("/:id/database",v("json",DatabaseRequest),async c => respond(c,ok(await artifactDatabase.call(id(c),c.req.valid("json"),identity(c),c.req.raw.signal))))
  .post("/:id/database/inspect",v("json",DatabaseRequest),async c => respond(c,ok(await artifactDatabase.call(id(c),c.req.valid("json"),identity(c),c.req.raw.signal,"inspect"))))
  .post("/runtime/capabilities",v("json",RuntimeCapabilityRequest),async c=>respond(c,ok(await runtimeCapabilities.prepare(c.req.valid("json"),identity(c),caller(c)))))
  .post("/runtime/capabilities/:callId/resolve",v("json",z.object({approved:z.boolean(),remember:z.literal("always").optional()}).strict()),async c=>respond(c,ok(await runtimeCapabilities.resolve(z.uuid().parse(c.req.param("callId")),c.req.valid("json"),identity(c),caller(c)))))
  .get("/runtime/host.js", async c => c.body(await cliHostBundle(), 200, { "Content-Type": "application/javascript; charset=utf-8" }))
  .post("/runtime/claim", v("json", ClientCall), async (c) => respond(c, ok(await clientCalls.claim(c.req.valid("json"), identity(c)))))
  .post("/runtime/complete", v("json", ClientCallResult), async (c) => respond(c, ok(await clientCalls.complete(c.req.valid("json"), identity(c)))))
  .post("/", v("json",ArtifactCreate), async (c) => respond(c,ok(await artifacts.create(c.req.valid("json"),identity(c))),201))
  .post("/runtime/compile", v("json", ArtifactSource), async c => {
    try { return respond(c,ok(await compileArtifact(c.req.valid("json")))); }
    catch (error) { return respond(c,{ ok: false, status: 400, code: "COMPILE_FAILED", error: compilationDiagnostic(error) }); }
  })
  .post("/runtime/action", v("query", z.object({ conversationId: z.string().max(80).optional() })), v("json", CodeActionInput), async c => {
    const input = c.req.valid("json");
    const draft = input.revision !== undefined;
    const bundle = await artifacts.get(input.id, identity(c), undefined, !draft);
    if (draft && bundle.permission !== "admin") throw new ArtifactError("ACCESS_DENIED");
    if (draft ? bundle.sourceRevision !== input.revision : bundle.publishedVersion !== input.publishedVersion) throw new ArtifactError("CONFLICT");
    const action = sourceActions(bundle.source).find(action => action.name === input.action);
    if (!action) throw new ArtifactError("NOT_FOUND");
    actionValidator(action.inputSchema).parse(input.input);
    const compiled = await compileArtifact(bundle.source, { action: input.action, input: input.input });
    const current = await artifacts.get(input.id, identity(c), undefined, !draft);
    if (draft && current.permission !== "admin") throw new ArtifactError("ACCESS_DENIED");
    if (draft ? current.sourceRevision !== input.revision : current.publishedVersion !== input.publishedVersion) throw new ArtifactError("CONFLICT");
    return respond(c, ok({ compiled, outputSchema: action.outputSchema,
      resource: { id: bundle.id, kind: bundle.kind, sourceRevision: bundle.sourceRevision } }));
  })
  .post("/runtime/rename",v("json",z.object({source:ArtifactSource,from:z.string().max(180),to:z.string().max(180)}).strict()),async c=>{
    const input=c.req.valid("json");
    try{return respond(c,ok(renameSource(input.source,input.from,input.to)));}
    catch{return respond(c,{ok:false,status:400,code:"INVALID_INPUT",error:artifactMessages.resolve([getLocale(c)]).t.INVALID_INPUT});}
  })
  .post("/validate", v("json",ArtifactSource), async (c) => {
    try { await compileArtifact(c.req.valid("json")); return respond(c,ok({ valid: true, diagnostics: [] })); }
    catch (error) { return respond(c,ok({ valid: false, diagnostics: [compilationDiagnostic(error)] })); }
  })
  .delete("/:id",async c => respond(c,ok(await artifacts.remove(id(c),identity(c)))))
  .get("/:id/actions", v("query", RevisionQuery.extend({ draft: z.enum(["true"]).optional() })), async c => {
    const draft = c.req.valid("query").draft === "true";
    const bundle = await artifacts.get(id(c), identity(c), undefined, !draft);
    if (draft && bundle.permission !== "admin") throw new ArtifactError("ACCESS_DENIED");
    return respond(c, ok({ id: bundle.id, publishedVersion: bundle.publishedVersion, revision: bundle.sourceRevision, actions: sourceActions(bundle.source) }));
  })
  .get("/:id", v("query", RevisionQuery), async (c) => respond(c,ok(await artifacts.get(id(c),identity(c),revision(c),c.req.query("published") === "true", c.req.query("version") === undefined ? undefined : z.coerce.number().int().positive().parse(c.req.query("version"))))))
  .post("/:id/publish", v("json", z.object({ expectedRevision: z.number().int().positive(), note: PublicationNote }).strict()), async c =>
    respond(c, ok(await artifacts.publish(id(c), c.req.valid("json").expectedRevision, identity(c), c.req.valid("json").note))))
  .get("/:id/versions", v("query", PageQuery), async c => respond(c,ok(await artifacts.versions(id(c),identity(c),page(c)))))
  .post("/:id/restore", v("json", z.object({version:z.number().int().positive(),expectedRevision:z.number().int().positive()}).strict()), async c => respond(c,ok(await artifacts.restore(id(c),c.req.valid("json").version,c.req.valid("json").expectedRevision,identity(c)))))
  .patch("/:id/metadata", v("json", ArtifactMetadata), async c => respond(c,ok(await artifacts.metadata(id(c),c.req.valid("json"),identity(c)))))
  .post("/:id/unpublish", async c => respond(c, ok(await artifacts.unpublish(id(c), identity(c)))))
  .post("/:id/fork", async c => respond(c, ok(await artifacts.fork(id(c), identity(c))), 201))
  .post("/:id/edit-chat", v("query", z.object({ intent: z.literal("customize").optional() })), async c => respond(c, ok(await artifacts.editChat(id(c), identity(c),
    c.req.valid("query").intent === "customize" ? artifactMessages.resolve([getLocale(c)]).t.customizePrompt : undefined)), 201))
  .put("/:id/files",v("json",ArtifactFile),async c=>respond(c,ok(await artifacts.writeFile(id(c),c.req.valid("json").path,c.req.valid("json").content,identity(c)))))
  .put("/:id", v("json",ArtifactUpdate), async (c) => respond(c,ok(await artifacts.update(id(c),c.req.valid("json"),identity(c)))))
  .get("/:id/revisions", async (c) => respond(c,ok(await artifacts.history(id(c),identity(c),page(c)))))
  .get("/:id/compiled", v("query", RevisionQuery), async (c) => {
    const bundle = await artifacts.get(id(c),identity(c),revision(c));
    try { return respond(c,ok({ ...await compileArtifact(bundle.source), revision: bundle.sourceRevision })); }
    catch (error) { return respond(c,{ ok: false, status: 400, code: "COMPILE_FAILED", error: compilationDiagnostic(error) }); }
  })
  .get("/:id/storage/file", v("query",StorageFileQuery), async c => {
    const input=c.req.valid("query");
    const result=await artifacts.storage(id(c), {area:"files",operation:"read",key:input.key}, identity(c), input.management === "true");
    if (!("item" in result) || !result.item?.data) throw new ArtifactError("NOT_FOUND");
    return new Response(new Uint8Array(result.item.data), {headers:{
      "Content-Type":result.item.mediaType || "application/octet-stream",
      "Content-Disposition":"attachment", "X-Content-Type-Options":"nosniff", "Cache-Control":"private, no-store",
    }});
  })
  .put("/:id/storage/file", v("query",StorageFileQuery), async c => {
    const input=c.req.valid("query");
    // Authorize before accepting the body, then recheck under the write lock.
    const maximum=await artifacts.storageFileLimit(id(c),input.key,identity(c),input.management === "true");
    return bodyLimit({maxSize:maximum,onError:c=>c.json({code:"STORAGE_FULL",message:artifactMessages.resolve([getLocale(c)]).t.STORAGE_FULL},413)})(c,async()=>{
      const data=new Uint8Array(await c.req.arrayBuffer());
      const result=await artifacts.storage(id(c), {area:"files",operation:"write",key:input.key,mediaType:c.req.header("content-type") ?? "application/octet-stream"}, identity(c),input.management === "true",data);
      c.res=await respond(c,ok(result));
    });
  })
  .post("/:id/storage", v("query",z.object({conversationId:z.string().max(80).optional()})), v("json",StorageJsonRequest), async c => respond(c,ok(await artifacts.storage(id(c),c.req.valid("json"),identity(c)))))
  .post("/:id/storage/manage",v("json",StorageJsonRequest),async c => respond(c,ok(await artifacts.storage(id(c),c.req.valid("json"),identity(c),true))))
  .post("/:id/storage/clear",v("json",z.object({area:z.enum(["files","kv","all"]),confirmed:z.literal(true)}).strict()),async c => respond(c,ok(await artifacts.clearStorage(id(c),c.req.valid("json").area,identity(c)))))
  .get("/:id/projects", async c => respond(c,ok(await artifacts.projects(id(c),identity(c)))))
  .put("/:id/projects/:projectId", v("json",z.object({linked:z.boolean()}).strict()), async c => respond(c,ok(await artifacts.linkProject(id(c),z.string().min(1).max(80).parse(c.req.param("projectId")),c.req.valid("json").linked,identity(c)))))
  .get("/:id/access", async (c) => respond(c,ok(await artifacts.access(id(c),identity(c)))))
  .post("/:id/access", v("json",Grant), async (c) => {
    const input = c.req.valid("json");
    return respond(c,ok(await artifacts.grant(id(c),input.principal,input.permission,identity(c))));
  })
  .put("/:id/access/:accessId", v("json",z.object({ permission: Level.nullable() }).strict()), async (c) =>
    respond(c,ok(await artifacts.changeGrant(id(c),z.uuid().parse(c.req.param("accessId")),c.req.valid("json").permission,identity(c)))));

export const artifactApi = new Hono<AuthContext>()
  .use("*",auth.requireRole("authenticated"))
  .use("*",auth.requireUser())
  .route("/",createArtifactServiceRoutes());
