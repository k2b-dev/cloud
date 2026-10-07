import { type AuthContext, auth, getLocale, rateLimit, respond } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { etag } from "hono/etag";
import { z } from "zod";
import { hasInterface } from "./contracts";
import { appFrameAssets } from "./html/assets";
import { artifactMessages } from "./messages";
import { RunnerMetadata } from "./runner-contracts";
import { ChunkName, chunkSource } from "./runtime/chunks";
import { viewerContext } from "./runtime/context";
import { ArtifactError, artifacts } from "./service";

export const runnerMetadata = (bundle: Awaited<ReturnType<typeof artifacts.runner>>) =>
  RunnerMetadata.parse({ ...bundle, hasInterface: hasInterface(bundle.source) });
/** The published files of an app, read in the same transaction as its metadata. */
export async function runnerApp(id: string, identity: Parameters<typeof artifacts.runner>[1]) {
  const bundle = await artifacts.runner(id, identity);
  return { metadata: runnerMetadata(bundle), files: bundle.source.files };
}

/** Only published runner reads are exposed here. All server effects retain authenticated routes. */
export const createRunnerRoutes = () =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .onError((error, c) => {
      const code = error instanceof ArtifactError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "REQUEST_FAILED";
      if (code === "REQUEST_FAILED") console.error("Studio runner failed", error);
      return respond(c, {
        ok: false,
        code,
        status:
          code === "NOT_FOUND" ? 404 : code === "ACCESS_DENIED" ? 403 : code === "CONFLICT" ? 409 : code === "INVALID_INPUT" ? 400 : 500,
        error: artifactMessages.resolve([getLocale(c)]).t[code],
      });
    })
    .get("/app-assets", etag(), async (c) => c.json(await appFrameAssets(), 200, { "Cache-Control": "no-cache" }))
    .get("/chunks/:name", etag(), async (c) =>
      c.body(await chunkSource(ChunkName.parse(c.req.param("name"))), 200, {
        "Content-Type": "text/javascript",
        "Cache-Control": "no-cache",
      }),
    )
    .get("/:id", async (c) =>
      respond(
        c,
        ok(runnerMetadata(await artifacts.runner(c.req.param("id"), { actor: c.get("actor"), accessSubject: c.get("accessSubject") }))),
      ),
    )
    .get("/:id/app", async (c) =>
      respond(
        c,
        ok({
          ...(await runnerApp(c.req.param("id"), { actor: c.get("actor"), accessSubject: c.get("accessSubject") })),
          context: viewerContext(c),
        }),
      ),
    );

export const runnerApi = new Hono<AuthContext>().use("*", auth.requireRole("*")).use(rateLimit()).route("/", createRunnerRoutes());
