import { env } from "@k2b/cloud/config";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CodeHostBusyError, createCliCodeHost } from "../cli/code-host";
import { ActionInputError, parseActionInput, sourceActions } from "./actions";
import { LIMITS } from "./contracts";
import { artifactDatabase } from "./database";
import { FlatDatabaseRequest } from "./database-runtime";
import { HTTP_CALL_TTL_MS } from "./http-contracts";
import { machineAudit } from "./machine-audit";
import { MachineExecution, type MachineHostInput } from "./machine-contracts";
import { machineHttp, requireMachineExecution } from "./machine-service";
import { ChunkName, chunkSource } from "./runtime/chunks";
import { cliHostBundle } from "./runtime/cli-bundle";
import { compileArtifact } from "./runtime/compile";
import { ArtifactError, type ArtifactIdentity, artifacts, readArtifactRevision } from "./service";
import { StorageRequest } from "./storage-contracts";

export class MachineExecutionError extends Error {
  constructor(
    readonly code:
      | "EXECUTION_FAILED"
      | "EXECUTION_UNKNOWN"
      | "EXECUTION_TIMEOUT"
      | "EXECUTION_CANCELLED"
      | "EXECUTION_BUSY"
      | "EXECUTION_ALREADY_ADMITTED",
  ) {
    super(code);
  }
}
type MachineHost = Pick<Awaited<ReturnType<typeof createCliCodeHost>>, "machine" | "close">;
const active = new Map<string, { abort: AbortController; done: Promise<void> }>();
export async function closeMachineHosts() {
  const runs = [...active.values()];
  for (const run of runs) run.abort.abort();
  await Promise.all(runs.map((run) => run.done));
}
export const activeMachineHosts = () => active.size;

async function record(id: string, status: string, error: string | null = null) {
  await sql`UPDATE assistant.artifact_machine_runs SET status=${status},error_code=${error},finished_at=now() WHERE id=${id}::uuid`;
}

/** A durable admission prevents duplicate delivery from replaying an external effect. */
export async function executeMachine(
  id: string,
  input: MachineExecution,
  identity: ArtifactIdentity,
  options: { signal: AbortSignal; locale: string; timeZone: string },
  hostFactory: (context: Parameters<typeof createCliCodeHost>[0]) => Promise<MachineHost> = (context) =>
    createCliCodeHost(context, undefined, {
      ...(env.NODE_ENV === "production" ? { entry: new URL("./assistant-code-host-process.js", import.meta.url).pathname } : {}),
    }),
) {
  const request = MachineExecution.parse(input);
  if (Math.abs(Date.now() - request.createdAt) > HTTP_CALL_TTL_MS) throw new ArtifactError("CONFLICT");
  if (active.size >= LIMITS.codeHosts) throw new MachineExecutionError("EXECUTION_BUSY");
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal, AbortSignal.timeout(45000)]);
  const currentIdentity: ArtifactIdentity = { ...identity, machineExecution: { version: request.publishedVersion } };
  try {
    await sql.begin(async (db) => {
      const { row } = await requireMachineExecution(db, id, currentIdentity, request.publishedVersion);
      signal.throwIfAborted();
      const published = await readArtifactRevision(db, row, "read", row.published_revision!);
      const action = request.action ? sourceActions(published.source).find((action) => action.name === request.action) : undefined;
      if (request.action && !action) throw new ArtifactError("NOT_FOUND");
      try {
        if (action) parseActionInput(action, request.input);
        else if (request.input !== undefined || published.source.entry.endsWith(".html")) throw new ArtifactError("INVALID_INPUT");
      } catch (error) {
        if (error instanceof ActionInputError) throw new ArtifactError("INVALID_INPUT");
        throw error;
      }
      if (currentIdentity.actor.kind !== "service_account") throw new ArtifactError("ACCESS_DENIED");
      await db`DELETE FROM assistant.artifact_machine_runs WHERE id IN
        (SELECT id FROM assistant.artifact_machine_runs WHERE created_at < now() - interval '2 days' ORDER BY created_at LIMIT ${LIMITS.rows})`;
      const admitted =
        await db`INSERT INTO assistant.artifact_machine_runs(id,artifact_id,principal_id,credential_id,version,operation,status)
      VALUES(${request.requestId}::uuid,${row.id}::uuid,${currentIdentity.actor.serviceAccount.id}::uuid,
      ${currentIdentity.actor.credentialId ?? currentIdentity.machineCredential!.reference},${request.publishedVersion},${request.action ?? "run"},'running') ON CONFLICT DO NOTHING RETURNING id`;
      if (!admitted.length) throw new MachineExecutionError("EXECUTION_ALREADY_ADMITTED");
      await machineAudit(
        currentIdentity,
        { id, requestId: request.requestId, version: request.publishedVersion },
        "admit",
        "allowed",
        undefined,
        db,
      );
    });
  } catch (error) {
    await machineAudit(
      currentIdentity,
      { id, requestId: request.requestId, version: request.publishedVersion },
      "admit",
      "denied",
      error instanceof ArtifactError ? error.code : "EXECUTION_FAILED",
    );
    throw error;
  }
  const completion = Promise.withResolvers<void>();
  active.set(request.requestId, { abort, done: completion.promise });
  let host: MachineHost | undefined;
  let polling: Promise<unknown> | undefined;
  let authorityLost = false;
  const check = () => sql.begin((db) => requireMachineExecution(db, id, currentIdentity, request.publishedVersion));
  const watchdog = setInterval(() => {
    if (polling) return;
    polling = check()
      .catch(() => {
        authorityLost = true;
        abort.abort();
      })
      .finally(() => {
        polling = undefined;
      });
  }, 1000);
  const stop = () => {
    void host?.close().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const router = createMachineHostRoutes({
      id,
      input: { ...request, artifactId: id },
      identity: currentIdentity,
      locale: options.locale,
      timeZone: options.timeZone,
      signal,
    });
    host = await hostFactory({
      fetch: async (path, init) => {
        signal.throwIfAborted();
        return router.fetch(
          new Request(new URL(String(path), "http://localhost"), {
            ...init,
            signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
          }),
        );
      },
    });
    signal.throwIfAborted();
    await check();
    const result = await host.machine({ ...request, artifactId: id }, signal);
    await check();
    signal.throwIfAborted();
    await sql.begin(async (db) => {
      await db`UPDATE assistant.artifact_machine_runs SET status='completed',finished_at=now() WHERE id=${request.requestId}::uuid`;
      await machineAudit(
        currentIdentity,
        { id, requestId: request.requestId, version: request.publishedVersion },
        "complete",
        "allowed",
        undefined,
        db,
      );
    });
    return { requestId: request.requestId, result };
  } catch (error) {
    const code = authorityLost
      ? "ACCESS_DENIED"
      : signal.aborted
        ? signal.reason?.name === "TimeoutError"
          ? "EXECUTION_TIMEOUT"
          : "EXECUTION_CANCELLED"
        : error instanceof CodeHostBusyError
          ? "EXECUTION_BUSY"
          : error instanceof ArtifactError || error instanceof MachineExecutionError
            ? error.code
            : "EXECUTION_UNKNOWN";
    await record(request.requestId, "failed", code);
    await machineAudit(
      currentIdentity,
      { id, requestId: request.requestId, version: request.publishedVersion },
      "complete",
      "failed",
      code,
    );
    if (authorityLost) throw new ArtifactError("ACCESS_DENIED");
    if (error instanceof CodeHostBusyError) throw new MachineExecutionError("EXECUTION_BUSY");
    if (error instanceof ArtifactError || error instanceof MachineExecutionError) throw error;
    throw new MachineExecutionError(code === "EXECUTION_TIMEOUT" || code === "EXECUTION_CANCELLED" ? code : "EXECUTION_UNKNOWN");
  } finally {
    clearInterval(watchdog);
    signal.removeEventListener("abort", stop);
    abort.abort();
    try {
      await host?.close();
      await polling;
    } finally {
      active.delete(request.requestId);
      completion.resolve();
    }
  }
}

/** The host can reach only these operations on its pinned artifact; it never calls the human router. */
export function createMachineHostRoutes(context: {
  id: string;
  input: MachineHostInput;
  identity: ArtifactIdentity;
  locale: string;
  timeZone: string;
  signal: AbortSignal;
}) {
  const { id, identity, input, signal } = context;
  const authorize = () => sql.begin((db) => requireMachineExecution(db, id, identity, input.publishedVersion));
  return new Hono<AuthContext>()
    .use("*", async (c, next) => {
      const operation = c.req.path.split("/").at(-1)!;
      if (operation === "host.js" || c.req.path.includes("/chunks/")) return next();
      await next();
      await machineAudit(
        identity,
        { id, requestId: input.requestId, version: input.publishedVersion },
        operation,
        c.res.ok ? "allowed" : "denied",
        c.res.ok ? undefined : "EFFECT_FAILED",
      );
    })
    .onError((error, c) => {
      const code = error instanceof ArtifactError ? error.code : "EXECUTION_FAILED";
      return c.json({ code }, code === "NOT_FOUND" ? 404 : code === "ACCESS_DENIED" ? 403 : 400);
    })
    .use("*", async (_c, next) => {
      signal.throwIfAborted();
      await authorize();
      await next();
    })
    .get("/api/assistant/artifacts/runtime/host.js", async (c) =>
      c.body(await cliHostBundle(), 200, { "content-type": "application/javascript" }),
    )
    .get("/api/assistant/artifacts/runtime/chunks/:name", async (c) =>
      c.body(await chunkSource(ChunkName.parse(c.req.param("name"))), 200, { "content-type": "application/javascript" }),
    )
    .post("/api/assistant/artifacts/runtime/machine/prepare", async (c) => {
      // Ignore browser-supplied authority: this host is bound to one admitted call.
      const bundle = await artifacts.get(id, identity, undefined, true);
      const action = input.action ? sourceActions(bundle.source).find((action) => action.name === input.action) : undefined;
      if (input.action && !action) throw new ArtifactError("NOT_FOUND");
      if (action) parseActionInput(action, input.input);
      else if (input.input !== undefined) throw new ArtifactError("INVALID_INPUT");
      const compiled = await compileArtifact(bundle.source, action ? { action: action.name, input: input.input } : undefined);
      await authorize();
      return c.json({
        ...compiled,
        context: { locale: context.locale, timeZone: context.timeZone, user: null },
        outputSchema: action?.outputSchema ?? null,
      });
    })
    .post("/api/assistant/artifacts/runtime/machine/storage", async (c) => {
      const body = StorageRequest.parse(await c.req.json());
      if (body.scope === "user") throw new ArtifactError("ACCESS_DENIED");
      const result = await artifacts.storage(id, body, identity, false, undefined, undefined, AbortSignal.any([signal, c.req.raw.signal]));
      return c.json(result);
    })
    .get("/api/assistant/artifacts/runtime/machine/storage/file", async (c) => {
      const result = await artifacts.storage(
        id,
        { area: "files", operation: "read", key: c.req.query("key") },
        identity,
        false,
        undefined,
        undefined,
        AbortSignal.any([signal, c.req.raw.signal]),
      );
      if (!("item" in result) || !result.item?.data) throw new ArtifactError("NOT_FOUND");
      return new Response(new Uint8Array(result.item.data), {
        headers: { "content-type": result.item.mediaType || "application/octet-stream" },
      });
    })
    .put("/api/assistant/artifacts/runtime/machine/storage/file", async (c) => {
      const key = z.string().min(1).max(240).parse(c.req.query("key"));
      const maximum = await artifacts.storageFileLimit(id, key, identity, false, AbortSignal.any([signal, c.req.raw.signal]));
      return bodyLimit({ maxSize: maximum })(c, async () => {
        const result = await artifacts.storage(
          id,
          { area: "files", operation: "write", key, mediaType: c.req.header("content-type") ?? "application/octet-stream" },
          identity,
          false,
          new Uint8Array(await c.req.arrayBuffer()),
          undefined,
          AbortSignal.any([signal, c.req.raw.signal]),
        );
        c.res = c.json(result);
      });
    })
    .post("/api/assistant/artifacts/runtime/machine/database", async (c) =>
      c.json(
        await artifactDatabase.runtime(
          id,
          FlatDatabaseRequest.parse(await c.req.json()),
          identity,
          AbortSignal.any([signal, c.req.raw.signal]),
        ),
      ),
    )
    .post("/api/assistant/artifacts/runtime/machine/http", async (c) =>
      c.json(await machineHttp(id, input.publishedVersion, await c.req.json(), identity, AbortSignal.any([signal, c.req.raw.signal]))),
    );
}
