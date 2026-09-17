import { Hono } from "hono";
import { auth, rateLimit, respond, getLocale, type AuthContext } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { artifacts, ArtifactError } from "./service";
import { RunnerMetadata } from "./runner-contracts";
import { compileArtifact, compilationDiagnostic } from "./runtime/compile";
import { ArtifactCompileError } from "./actions";
import { artifactMessages } from "./messages";

export const runnerMetadata = (bundle: Awaited<ReturnType<typeof artifacts.runner>>) => RunnerMetadata.parse(bundle);
export async function compiledRunner(id: string, identity: Parameters<typeof artifacts.runner>[1]) {
  const bundle = await artifacts.runner(id, identity);
  const compiled = await compileArtifact(bundle.source);
  // Compilation is asynchronous: recheck publication and grants before returning bytes.
  const current = await artifacts.runner(id, identity);
  if (current.sourceRevision !== bundle.sourceRevision || current.serverAccess !== bundle.serverAccess)
    throw new ArtifactError("CONFLICT");
  return { ...compiled, metadata: runnerMetadata(current) };
}

/** Only published runner reads are exposed here. All server effects retain authenticated routes. */
export const createRunnerRoutes = () => new Hono<AuthContext>()
  .use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); })
  .onError((error, c) => {
    if (error instanceof ArtifactCompileError) return respond(c, { ok: false, code: "COMPILE_FAILED", status: 400, error: compilationDiagnostic(error) });
    const code = error instanceof ArtifactError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "REQUEST_FAILED";
    if (code === "REQUEST_FAILED") console.error("Studio runner failed", error);
    return respond(c, { ok: false, code, status: code === "NOT_FOUND" ? 404 : code === "ACCESS_DENIED" ? 403 : code === "CONFLICT" ? 409 : code === "INVALID_INPUT" ? 400 : 500,
      error: artifactMessages.resolve([getLocale(c)]).t[code] });
  })
  .get("/:id", async c => respond(c, ok(runnerMetadata(await artifacts.runner(c.req.param("id"), { actor: c.get("actor"), accessSubject: c.get("accessSubject") })))))
  .get("/:id/compiled", async c => respond(c, ok(await compiledRunner(c.req.param("id"), { actor: c.get("actor"), accessSubject: c.get("accessSubject") }))));

export const runnerApi = new Hono<AuthContext>().use("*", auth.requireRole("*")).use(rateLimit()).route("/", createRunnerRoutes());
