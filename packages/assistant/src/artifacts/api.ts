import { type AuthContext, auth, getLocale, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ArtifactCreate, ArtifactSource, ArtifactUpdate, LIMITS } from "./contracts";
import { artifacts, ArtifactError } from "./service";
import { artifactMessages } from "./messages";
import { compilationDiagnostic, compileArtifact } from "./runtime/compile";
import { ClientCall, ClientCallResult, clientCalls } from "./client-calls";

const identity = (c: Context<AuthContext>) => ({ actor: c.get("actor"), accessSubject: c.get("accessSubject") });
const id = (c: Context<AuthContext>) => z.uuid().parse(c.req.param("id"));
const page = (c: Context<AuthContext>) => z.coerce.number().int().min(1).max(100000).parse(c.req.query("page") ?? 1);
const revision = (c: Context<AuthContext>) => c.req.query("revision") === undefined ? undefined
  : z.coerce.number().int().positive().parse(c.req.query("revision"));
const Level = z.enum(["read", "write", "admin"]);
const PageQuery = z.object({ page: z.string().optional() });
const RevisionQuery = z.object({ revision: z.string().optional() });
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
    const code = error instanceof ArtifactError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "REQUEST_FAILED";
    const status = code === "NOT_FOUND" ? 404 : code === "ACCESS_DENIED" ? 403
      : code === "CONFLICT" || code === "LAST_MANAGER" ? 409 : code === "REQUEST_FAILED" ? 500 : 400;
    if (code === "REQUEST_FAILED") console.error("Assistant artifact request failed", error);
    return respond(c,{ ok: false, code, status, error: artifactMessages.resolve([getLocale(c)]).t[code] });
  })
  .get("/", v("query", PageQuery), async (c) => respond(c,ok(await artifacts.list(identity(c),page(c)))))
  .post("/runtime/claim", v("json", ClientCall), async (c) => respond(c, ok(await clientCalls.claim(c.req.valid("json"), identity(c)))))
  .post("/runtime/complete", v("json", ClientCallResult), async (c) => respond(c, ok(await clientCalls.complete(c.req.valid("json"), identity(c)))))
  .post("/", v("json",ArtifactCreate), async (c) => respond(c,ok(await artifacts.create(c.req.valid("json"),identity(c))),201))
  .post("/validate", v("json",ArtifactSource), async (c) => {
    try { await compileArtifact(c.req.valid("json")); return respond(c,ok({ valid: true, diagnostics: [] })); }
    catch (error) { return respond(c,ok({ valid: false, diagnostics: [compilationDiagnostic(error)] })); }
  })
  .get("/:id", async (c) => respond(c,ok(await artifacts.get(id(c),identity(c),revision(c)))))
  .put("/:id", v("json",ArtifactUpdate), async (c) => respond(c,ok(await artifacts.update(id(c),c.req.valid("json"),identity(c)))))
  .get("/:id/revisions", async (c) => respond(c,ok(await artifacts.history(id(c),identity(c),page(c)))))
  .get("/:id/compiled", v("query", RevisionQuery), async (c) => {
    const bundle = await artifacts.get(id(c),identity(c),revision(c));
    try { return respond(c,ok({ ...await compileArtifact(bundle.source), revision: bundle.sourceRevision })); }
    catch (error) { return respond(c,{ ok: false, status: 400, code: "COMPILE_FAILED", error: compilationDiagnostic(error) }); }
  })
  .get("/:id/access", async (c) => respond(c,ok(await artifacts.access(id(c),identity(c)))))
  .post("/:id/access", v("json",Grant), async (c) => {
    const input = c.req.valid("json");
    return respond(c,ok(await artifacts.grant(id(c),input.principal,input.permission,identity(c))));
  })
  .put("/:id/access/:accessId", v("json",z.object({ permission: Level.nullable() }).strict()), async (c) =>
    respond(c,ok(await artifacts.changeGrant(id(c),z.uuid().parse(c.req.param("accessId")),c.req.valid("json").permission,identity(c)))));
