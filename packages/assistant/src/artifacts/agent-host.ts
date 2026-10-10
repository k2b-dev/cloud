import { isDeepStrictEqual } from "node:util";
import {
  AI_WEBSITE_APPROVAL_TOOL,
  type AiApprovalTarget,
  aiChatTasks,
  aiConversations,
  aiTurnAllowsWebsiteApprovals,
  aiWebsiteApprovalScope,
  authorizeCodeExecution,
  createAiConversationArtifact,
  createCodeCapabilityTransport,
  findRememberedAiToolApproval,
  listAiConversationFiles,
  parseCodeToolInput,
  readAiConversationFile,
} from "@k2b/cloud/ai";
import { CodeCheckInput } from "@k2b/cloud/ai/browser";
import { env } from "@k2b/cloud/config";
import { type AuthContext, LOCALE_HEADER, TIMEZONE_COOKIE } from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { createCliCodeHost } from "../cli/code-host";
import { runCodeAi } from "./ai-service";
import { createArtifactServiceRoutes } from "./api";
import { backgroundCodeRouteAllowed, backgroundDatabaseOperation } from "./background-code-policy";
import { RuntimeCapabilityRequest, runtimeCapabilities } from "./capability-runtime";
import { codeApprovalMessage } from "./code-approval-message";
import type { CodeToolContext } from "./code-tools";
import { LIMITS } from "./contracts";
import { DatabaseRequest } from "./database-contracts";
import { FlatDatabaseRequest } from "./database-runtime";
import { appChecks } from "./html/check-service";
import { httpService } from "./http-service";

export const AgentHostRequest = z
  .object({
    turnId: z.uuid(),
    callId: z.string().min(1).max(180),
    name: z.enum(["code_run", "code_action", "code_inspect", "code_stop", "code_export", "code_present", "code_check"]),
    args: z.unknown(),
    decision: z.object({ id: z.uuid(), approved: z.boolean() }).optional(),
    /** How many receipts of this call the caller already has; the answer continues after them. */
    receiptsAfter: z.number().int().min(0).optional(),
  })
  .strict();
type Call = z.infer<typeof AgentHostRequest>;
const ApprovalTarget = z.object({ toolName: z.string(), approvalScope: z.string(), always: z.boolean() });
/** A request a remembered website approval let through without asking; the chat shows it with its full URL. */
const Receipt = z.object({ method: z.string(), url: z.string() });
/**
 * Receipts per poll answer. Core reads at most 256 KiB per answer; a receipt holds one URL of at most 2,000
 * characters, so 50 take at most about 100 KiB and leave the rest to the call's approvals.
 */
const RECEIPTS_PER_POLL = 50;
type Host = Awaited<ReturnType<typeof createCliCodeHost>>;
type Session = {
  phase: "starting" | "running";
  id: string;
  conversationId: string;
  turnId: string;
  key: string;
  background: boolean;
  context: CodeToolContext;
  host: Promise<Host>;
  lastUsed: number;
  busy: Set<string>;
  checks: Map<string, { controller: AbortController; operation: Promise<void> }>;
  checkScopes: Set<string>;
  lastCall?: { turnId: string; callId: string };
  capabilityTransport: ReturnType<typeof createCodeCapabilityTransport>;
  capabilityContext?: { conversationId: string; turnId: string; token: string };
  decisions: Map<string, (approved: boolean) => void>;
};
const sessions = new Map<string, Session>();
const IDLE_MS = 120_000;
const keyOf = (turnId: string, callId: string) => `${turnId}:${callId}`;

async function closeSession(session: Session) {
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  for (const resolve of session.decisions.values()) resolve(false);
  session.decisions.clear();
  for (const check of session.checks.values()) check.controller.abort();
  await session.host.then(
    (host) => host.close(),
    () => {},
  );
  // Also recover a start response lost when its caller disconnected.
  for (const id of session.checkScopes) await appChecks.discard(id, session.context);
  session.checkScopes.clear();
  await sql`UPDATE assistant.artifact_agent_calls SET status='lost',updated_at=now()
    WHERE host_id=${session.id}::uuid AND status='running'`;
}

async function authorize(context: CodeToolContext, turnId: string) {
  if (context.actor.kind !== "user" || !context.conversationId) throw new Error("Code host requires a user conversation");
  const { config } = await authorizeCodeExecution(context.conversationId, turnId, context.actor.user.id);
  return { user: context.actor.user, key: config.background ? turnId : context.conversationId };
}

export async function hostFetch(context: CodeToolContext, session: Session, path: string, init?: RequestInit): Promise<Response> {
  if (context.actor.kind !== "user" || !context.conversationId) throw new Error("User required");
  const url = new URL(path, "http://localhost");
  if (url.pathname === "/api/assistant/artifacts/runtime/check/discard" && init?.method === "POST") {
    const { id } = z
      .object({ id: z.string() })
      .strict()
      .parse(await new Request(url, init).json());
    if (session.checkScopes.has(id)) {
      // Cancellation revokes execution authority, not cleanup of this host's
      // own disposable copies. The service still checks scratch/admin access.
      await appChecks.discard(id, context);
      session.checkScopes.delete(id);
      return Response.json({ discarded: true });
    }
  }
  const { config } = await authorizeCodeExecution(context.conversationId, session.turnId, context.actor.user.id);
  const prefix = `/api/ai/conversations/${context.conversationId}/files`;
  if (url.pathname === prefix && (init?.method ?? "GET") === "GET")
    return Response.json({ files: await listAiConversationFiles(context.conversationId) });
  if (url.pathname === `${prefix}/content` && (init?.method ?? "GET") === "GET") {
    const filePath = url.searchParams.get("path") ?? "";
    const stat = (await listAiConversationFiles(context.conversationId)).find((file) => file.path === filePath);
    const file =
      stat &&
      (await readAiConversationFile({
        conversationId: context.conversationId,
        ownerUserId: context.actor.user.id,
        path: filePath,
        version: url.searchParams.has("version") ? z.coerce.number().int().positive().parse(url.searchParams.get("version")) : stat.version,
      }));
    return file
      ? new Response(new Uint8Array(file.bytes).buffer, { headers: { "content-type": file.mediaType } })
      : new Response(null, { status: 404 });
  }
  if (url.pathname === prefix && init?.method === "POST") {
    const form = await new Request(url, init).formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Missing exported file");
    const producerCallKey = [...session.busy][0];
    if (!producerCallKey || session.busy.size !== 1) throw new Error("Export requires one active code call");
    const hash = new Bun.CryptoHasher("sha256").update(producerCallKey).digest("hex");
    const stored = await createAiConversationArtifact({
      conversationId: context.conversationId,
      ownerUserId: context.actor.user.id,
      path: `/files/${hash}/${file.name}`,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mediaType: file.type || "application/octet-stream",
      producerCallKey,
    });
    return Response.json({ file: stored });
  }
  if (!url.pathname.startsWith("/api/assistant/artifacts/")) throw new Error("Code host request is outside its API boundary");
  if (config.background && !backgroundCodeRouteAllowed(url.pathname.slice("/api/assistant/artifacts".length), init?.method ?? "GET"))
    return Response.json(
      {
        code: "BACKGROUND_ACCESS_DENIED",
        message:
          "Background code must use task-approved capabilities for external data and effects. This operation requires an interactive run.",
      },
      { status: 403 },
    );
  if (config.background && url.pathname === "/api/assistant/artifacts/runtime/check/capability")
    return Response.json({ ok: false, code: "unavailable", message: "not executed during code_check" }, { status: 403 });
  // Only this host's own check scopes bypass the task's real-data write grants.
  const scratchId = /^\/api\/assistant\/artifacts\/([^/]+)\/(?:database|storage)/.exec(url.pathname)?.[1];
  const [scratch] = scratchId
    ? await sql`SELECT check_scratch FROM assistant.artifacts
    WHERE short_id=${scratchId} AND check_conversation_id=${context.conversationId}::uuid AND check_scratch`
    : [];
  const headers = new Headers(init?.headers);
  let locale = context.locale,
    timeZone = context.timeZone,
    theme = context.theme ?? "light";
  if (config.background && url.pathname === "/api/assistant/artifacts/runtime/check/start") {
    const { input } = z
      .object({ input: CodeCheckInput, conversationId: z.uuid() })
      .strict()
      .parse(await new Request(url, init).json());
    if (input.id) {
      const [connected] = await sql`SELECT d.artifact_id FROM assistant.artifact_databases d
        JOIN assistant.artifacts a ON a.id=d.artifact_id WHERE a.short_id=${input.id} AND d.connected`;
      if (connected) {
        try {
          await aiChatTasks.authorizeRuntime({
            mandate: config.mandate!,
            kind: "database",
            input: { resourceId: input.id, operation: "export" },
          });
        } catch (error) {
          return Response.json(
            { code: "BACKGROUND_ACCESS_DENIED", message: error instanceof Error ? error.message : "Database access denied" },
            { status: 403 },
          );
        }
      }
    }
    // Resolve check preferences here; scheduled turns retain their existing
    // Core behavior and never inherit the latest interactive turn.
    const task = await aiChatTasks.get({ userId: context.actor.user.id, taskId: config.background.taskId });
    if (!task) throw new Error("Scheduled check task is unavailable");
    locale = config.locale ?? context.locale;
    timeZone = config.timeZone ?? task.timezone;
    theme = config.theme ?? "light";
  }
  headers.set(LOCALE_HEADER, locale);
  headers.set("cookie", `${TIMEZONE_COOKIE}=${encodeURIComponent(timeZone)}; theme=${theme}`);
  const request = new Request(url, { ...init, headers });
  const database = /^\/api\/assistant\/artifacts\/([^/]+)\/database(?:\/maintenance)?(\/connect)?$/.exec(url.pathname);
  if (config.background && config.mandate && database && !scratch && request.method === "POST") {
    const input = database[2]
      ? { operation: "connect" }
      : (url.pathname.includes("/maintenance") ? DatabaseRequest : FlatDatabaseRequest).parse(await request.clone().json());
    try {
      await aiChatTasks.authorizeRuntime({
        mandate: config.mandate,
        kind: "database",
        input: {
          resourceId: database[1],
          ...input,
          operation:
            url.pathname.includes("/maintenance") || database[2]
              ? input.operation
              : backgroundDatabaseOperation(FlatDatabaseRequest.parse(input).operation),
          table: "table" in input ? input.table : "name" in input ? input.name : undefined,
        },
      });
    } catch (error) {
      return Response.json(
        { code: "BACKGROUND_ACCESS_DENIED", message: error instanceof Error ? error.message : "Database access denied" },
        { status: 403 },
      );
    }
  }
  const router = new Hono<AuthContext>()
    .onError((error) => Response.json({ code: "CODE_HOST_REQUEST_FAILED", message: error.message }, { status: 403 }))
    .use("*", async (c, next) => {
      c.set("actor", context.actor);
      c.set("accessSubject", context.accessSubject);
      await next();
    })
    .post("/api/assistant/artifacts/runtime/capabilities", async (c, next) => {
      if (!config.background) return next();
      const input = RuntimeCapabilityRequest.parse(await c.req.json());
      if (input.conversationId !== context.conversationId) throw new Error("Code capability conversation mismatch");
      return c.json(
        await runtimeCapabilities.prepare(
          input,
          context,
          {
            transport: session.capabilityTransport,
            origin: "assistant",
            locale: context.locale,
            signal: c.req.raw.signal,
          },
          true,
        ),
      );
    })
    .post("/api/assistant/artifacts/runtime/http/:callId", async (c, next) => {
      if (!config.background || !config.mandate) return next();
      const decision = z
        .object({ approved: z.boolean() })
        .strict()
        .parse(await c.req.json());
      return c.json(
        await httpService.execute(c.req.param("callId"), decision.approved, context, c.req.raw.signal, undefined, async (stored) => {
          if (stored.scope.conversationId !== context.conversationId) throw new Error("HTTP conversation mismatch");
          await aiChatTasks.authorizeRuntime({
            mandate: config.mandate!,
            kind: "http",
            input: {
              url: stored.request.url,
              origin: new URL(stored.request.url).origin,
              method: stored.request.method,
            },
          });
        }),
      );
    })
    .post("/api/assistant/artifacts/runtime/ai", async (c, next) => {
      if (!config.background) return next();
      const input = z
        .object({
          request: z.unknown(),
          scope: z.object({ conversationId: z.literal(context.conversationId!), resourceId: z.string().optional() }),
        })
        .parse(await c.req.json());
      return c.json({ output: await runCodeAi(input.request, input.scope, context, c.req.raw.signal, session.turnId) });
    })
    .route(
      "/api/assistant/artifacts",
      createArtifactServiceRoutes(() => ({
        transport: session.capabilityTransport,
        origin: "assistant",
        locale: context.locale,
        signal: init?.signal ?? undefined,
      })),
    );
  const checking = session.lastCall ? session.checks.get(keyOf(session.lastCall.turnId, session.lastCall.callId))?.controller : undefined;
  const response = await router.fetch(request);
  if (url.pathname === "/api/assistant/artifacts/runtime/check/start" && response.ok) {
    const { scopeId } = z.object({ scopeId: z.string() }).parse(await response.clone().json());
    // A cancelled caller may never receive this scope ID. Do not retain it
    // until host shutdown when creation completed after cancellation.
    if (checking?.signal.aborted || init?.signal?.aborted) await appChecks.discard(scopeId, context);
    else session.checkScopes.add(scopeId);
  }
  return response;
}

async function createSession(context: CodeToolContext, turnId: string): Promise<Session> {
  if (context.actor.kind !== "user") throw new Error("User required");
  if (!context.conversationId) throw new Error("Conversation required");
  const { config } = await authorizeCodeExecution(context.conversationId, turnId, context.actor.user.id);
  const key = config.background ? turnId : context.conversationId;
  const existing = sessions.get(key);
  if (existing) {
    existing.turnId = turnId;
    existing.context = context;
    return existing;
  }
  if (sessions.size >= LIMITS.codeHosts) throw new Error("Code hosts are busy. Retry after a current run finishes.");
  const session: Session = {
    phase: "starting",
    id: crypto.randomUUID(),
    conversationId: context.conversationId,
    turnId,
    key,
    background: Boolean(config.background),
    context,
    lastUsed: Date.now(),
    busy: new Set(),
    checks: new Map(),
    checkScopes: new Set(),
    decisions: new Map(),
    capabilityTransport: createCodeCapabilityTransport(() => {
      if (!session.capabilityContext) throw new Error("Code capability authority expired");
      return session.capabilityContext;
    }),
    host: Promise.resolve().then(() =>
      createCliCodeHost(
        { fetch: (path, init) => hostFetch(session.context, session, String(path), init) },
        async (approval) => {
          const { config } = await authorizeCodeExecution(
            context.conversationId!,
            session.turnId,
            context.actor.kind === "user" ? context.actor.user.id : "",
          );
          if (config.background && config.mandate) {
            if (!("type" in approval) || approval.type !== "http")
              throw new Error("Background code cannot request interactive approval. Update the task in the normal chat.");
            await aiChatTasks.authorizeRuntime({
              mandate: config.mandate,
              kind: "http",
              input: { url: approval.url, origin: new URL(approval.url).origin, method: approval.method },
            });
            return { approved: true };
          }
          if (!session.lastCall) throw new Error("Approval has no originating code call");
          const { turnId, callId } = session.lastCall;
          const id = z.uuid().parse(approval.id);
          const actorUserId = context.actor.kind === "user" ? context.actor.user.id : "";
          // What the person may remember comes from the stored request, never from the approval the host sent.
          let target: AiApprovalTarget | null = null;
          if ("type" in approval) {
            const website = await httpService.website(id, context).catch(() => null);
            if (website && website.conversationId === context.conversationId) {
              target = { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: aiWebsiteApprovalScope(website.origin), always: false };
              // Website approvals are looked up only here, on the interactive path of a turn a person started in a
              // signed-in session; a scheduled task, mandate, or delegated credential always asks or uses its grants.
              if (
                aiTurnAllowsWebsiteApprovals(config) &&
                (await findRememberedAiToolApproval(
                  { actorUserId },
                  {
                    toolName: target.toolName,
                    approvalScope: target.approvalScope,
                    conversationId: context.conversationId,
                    chatOnly: true,
                  },
                ))
              ) {
                await sql`INSERT INTO assistant.artifact_agent_approvals(turn_id,call_id,id,message,decision,receipt)
      VALUES(${turnId}::uuid,${callId},${id}::uuid,${`${website.method} ${website.url}`},true,
        (${JSON.stringify({ method: website.method, url: website.url })}::text)::jsonb) ON CONFLICT DO NOTHING`;
                return { approved: true };
              }
            }
          } else {
            const [call] = await sql<{ name: string; allow_always: boolean | null; scope: string | null }[]>`
      SELECT request->>'name' AS name,(prepared->>'allowAlways')::boolean AS allow_always,prepared->>'scope' AS scope
      FROM assistant.capability_calls WHERE id=${id}::uuid AND user_id=${actorUserId}::uuid AND status='pending'`;
            if (call?.allow_always && call.scope) target = { toolName: call.name, approvalScope: call.scope, always: true };
          }
          await sql`INSERT INTO assistant.artifact_agent_approvals(turn_id,call_id,id,message,remember)
      VALUES(${turnId}::uuid,${callId},${id}::uuid,${codeApprovalMessage(approval, context.locale)},
        (${target ? JSON.stringify(target) : null}::text)::jsonb) ON CONFLICT DO NOTHING`;
          const approved = await new Promise<boolean>((resolve) => session.decisions.set(id, resolve));
          session.decisions.delete(id);
          return { approved };
        },
        {
          ...(env.NODE_ENV === "production" ? { entry: new URL("./assistant-code-host-process.js", import.meta.url).pathname } : {}),
        },
      ),
    ),
  };
  sessions.set(key, session);
  void session.host.then(
    () => {
      session.phase = "running";
    },
    () => {},
  );
  return session;
}

export const agentHost = {
  async call(call: Call, context: CodeToolContext) {
    const { user, key: sessionKey } = await authorize(context, call.turnId);
    const input = parseCodeToolInput(call.name, call.args);
    const key = keyOf(call.turnId, call.callId);
    let [row] = await sql<
      { host_id: string; input: unknown; status: string; result: unknown }[]
    >`SELECT host_id,input,status,result FROM assistant.artifact_agent_calls
      WHERE turn_id=${call.turnId}::uuid AND call_id=${call.callId} AND user_id=${user.id}::uuid`;
    if (row && !isDeepStrictEqual(row.input, input)) throw new Error("Code call input changed; no replay performed");
    let session = sessions.get(sessionKey);
    if (row?.status === "running" && (!session || session.id !== row.host_id || !session.busy.has(key))) {
      const changed =
        await sql`UPDATE assistant.artifact_agent_calls SET status='lost',updated_at=now() WHERE turn_id=${call.turnId}::uuid AND call_id=${call.callId} AND status='running' RETURNING call_id`;
      if (changed.length) row.status = "lost";
      else {
        // The SELECT can precede completion while the ownership check follows
        // it. Never overwrite a result committed in that interval.
        [row] = await sql<
          { host_id: string; input: unknown; status: string; result: unknown }[]
        >`SELECT host_id,input,status,result FROM assistant.artifact_agent_calls
          WHERE turn_id=${call.turnId}::uuid AND call_id=${call.callId} AND user_id=${user.id}::uuid`;
        if (!row) throw new Error("Code call disappeared; no replay performed");
      }
    }
    if (!row) {
      session = await createSession(context, call.turnId);
      if (context.capabilityToken)
        session.capabilityContext = { conversationId: context.conversationId!, turnId: call.turnId, token: context.capabilityToken };
      if (input.operation === "stop") {
        const check = session.checks.get(keyOf(call.turnId, input.runId));
        if (check) {
          check.controller.abort();
          await check.operation;
          return { status: "done", result: { stopped: true }, approvals: [] };
        }
      }
      if (session.busy.size) return { status: "busy", phase: "busy", approvals: [] };
      session.busy.add(key);
      session.lastCall = { turnId: call.turnId, callId: call.callId };
      let inserted: unknown[];
      try {
        inserted = await sql`INSERT INTO assistant.artifact_agent_calls(turn_id,call_id,user_id,conversation_id,host_id,input)
        VALUES(${call.turnId}::uuid,${call.callId},${user.id}::uuid,${context.conversationId}::uuid,${session.id}::uuid,(${JSON.stringify(input)}::text)::jsonb)
        ON CONFLICT DO NOTHING RETURNING call_id`;
      } catch (error) {
        session.busy.delete(key);
        throw error;
      }
      if (inserted.length) {
        const owned = session;
        const controller = call.name === "code_check" ? new AbortController() : undefined;
        const operation = owned.host
          .then((host) =>
            host.execute(
              {
                name: call.name,
                args: call.args,
                callId: call.callId,
                turnId: call.turnId,
                conversationId: context.conversationId!,
              },
              controller ? AbortSignal.any([context.signal, controller.signal]) : undefined,
            ),
          )
          .then(async (result) => {
            await sql`UPDATE assistant.artifact_agent_calls SET status='done',result=(${JSON.stringify(result)}::text)::jsonb,updated_at=now() WHERE turn_id=${call.turnId}::uuid AND call_id=${call.callId} AND host_id=${owned.id}::uuid AND status='running'`;
          })
          .catch(async () => {
            // If persistence is unavailable, retain the durable running guard.
            // A later poll sees that no local call owns it and reports lost;
            // execution is never retried after an uncertain write.
            await sql`UPDATE assistant.artifact_agent_calls SET status='lost',updated_at=now() WHERE turn_id=${call.turnId}::uuid AND call_id=${call.callId} AND status='running'`.catch(
              () => {},
            );
          })
          .finally(async () => {
            try {
              if (controller) {
                // Discard IDs the child could not receive, and retry teardown
                // whose transport was interrupted by turn cancellation.
                for (const id of owned.checkScopes) {
                  await appChecks.discard(id, context);
                  owned.checkScopes.delete(id);
                }
              }
            } finally {
              owned.busy.delete(key);
              owned.checks.delete(key);
              owned.lastUsed = Date.now();
            }
          });
        if (controller) {
          owned.checks.set(key, { controller, operation });
          // Keep the originating HTTP request open: its signal must still
          // observe a cancelled tool or detached caller between polls.
          await operation;
          context.signal.throwIfAborted();
          const [completed] = await sql<{ status: string; result: unknown }[]>`SELECT status,result FROM assistant.artifact_agent_calls
            WHERE turn_id=${call.turnId}::uuid AND call_id=${call.callId} AND host_id=${owned.id}::uuid`;
          if (!completed) throw new Error("Code call disappeared; no replay performed");
          return { ...completed, approvals: [] };
        }
        void operation.catch(() => {});
      } else session.busy.delete(key);
      return { status: "running", phase: session.phase, approvals: [] };
    }
    if (session && context.capabilityToken)
      session.capabilityContext = { conversationId: context.conversationId!, turnId: call.turnId, token: context.capabilityToken };
    if (session)
      await sql`INSERT INTO assistant.artifact_agent_approvals(turn_id,call_id,id,message,remember)
      SELECT ${call.turnId}::uuid,${call.callId},a.id,a.message,a.remember FROM assistant.artifact_agent_approvals a
      JOIN assistant.artifact_agent_calls c USING(turn_id,call_id)
      WHERE c.host_id=${session.id}::uuid AND a.decision IS NULL ORDER BY a.ordinal
      ON CONFLICT DO NOTHING`;
    if (call.decision) {
      const changed = await sql`UPDATE assistant.artifact_agent_approvals a SET decision=${call.decision.approved}
        FROM assistant.artifact_agent_calls c WHERE c.turn_id=a.turn_id AND c.call_id=a.call_id
        AND c.user_id=${user.id}::uuid AND c.host_id=${row.host_id}::uuid AND a.id=${call.decision.id}::uuid AND a.decision IS NULL
        AND EXISTS(SELECT 1 FROM assistant.artifact_agent_approvals current WHERE current.turn_id=${call.turnId}::uuid AND current.call_id=${call.callId} AND current.id=a.id)
        RETURNING a.id`;
      if (changed.length) session?.decisions.get(call.decision.id)?.(call.decision.approved);
    }
    if (session) session.lastUsed = Date.now();
    const rows = await sql<
      { id: string; message: string; decision: boolean | null; remember: unknown }[]
    >`SELECT id,message,decision,remember FROM assistant.artifact_agent_approvals
      WHERE turn_id=${call.turnId}::uuid AND call_id=${call.callId} AND receipt IS NULL ORDER BY ordinal`;
    const approvals = rows.map(({ id, message, decision, remember }) => ({
      id,
      message,
      decision,
      remember: remember ? ApprovalTarget.parse(remember) : undefined,
    }));
    // Receipts can grow with every request a run makes, so each answer carries only the next page of them.
    const page = await sql<{ receipt: unknown }[]>`SELECT receipt FROM assistant.artifact_agent_approvals
      WHERE turn_id=${call.turnId}::uuid AND call_id=${call.callId} AND receipt IS NOT NULL
      ORDER BY ordinal OFFSET ${call.receiptsAfter ?? 0} LIMIT ${RECEIPTS_PER_POLL + 1}`;
    const receipts = page.slice(0, RECEIPTS_PER_POLL).map((entry) => Receipt.parse(entry.receipt));
    const moreReceipts = page.length > RECEIPTS_PER_POLL;
    return {
      status: row.status,
      phase: approvals.some((approval) => approval.decision === null) ? "waiting_for_user" : session?.phase,
      // The result follows the last receipt, so one answer never carries both in full.
      result: moreReceipts ? undefined : row.result,
      approvals,
      receipts,
      moreReceipts,
    };
  },
  async sweep() {
    for (const session of sessions.values()) {
      try {
        if (session.background) await authorize(session.context, session.turnId);
        else {
          const active = await aiConversations.getActiveTurn({ conversationId: session.conversationId });
          if (
            active?.turn.cancelRequestedAt ||
            (session.busy.size && session.lastCall?.turnId !== active?.turn.id) ||
            (!active && Date.now() - session.lastUsed > IDLE_MS)
          ) {
            await closeSession(session);
            continue;
          }
        }
        await (await session.host).health();
      } catch {
        await closeSession(session);
      }
    }
  },
  async close() {
    await Promise.all([...sessions.values()].map(closeSession));
  },
};
