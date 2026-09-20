import { isDeepStrictEqual } from "node:util";
import {
  aiConversations,
  createAiConversationArtifact,
  createCodeCapabilityTransport,
  listAiConversationFiles,
  parseCodeToolInput,
  readAiConversationFile,
} from "@k2b/cloud/ai";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { createCliCodeHost } from "../cli/code-host";
import { createArtifactServiceRoutes } from "./api";
import type { CodeToolContext } from "./code-tools";
import type { CodeApproval } from "./runtime/capabilities";

export const AgentHostRequest = z
  .object({
    turnId: z.uuid(),
    callId: z.string().min(1).max(180),
    name: z.enum(["code_run", "code_action", "code_inspect", "code_interact", "code_stop", "code_export", "code_present"]),
    args: z.unknown(),
    decision: z.object({ id: z.uuid(), approved: z.boolean() }).optional(),
  })
  .strict();
type Call = z.infer<typeof AgentHostRequest>;
type Host = Awaited<ReturnType<typeof createCliCodeHost>>;
type Session = {
  phase: "starting" | "running";
  id: string;
  conversationId: string;
  host: Promise<Host>;
  lastUsed: number;
  busy: Set<string>;
  lastCall?: { turnId: string; callId: string };
  capabilityTransport: ReturnType<typeof createCodeCapabilityTransport>;
  capabilityContext?: { conversationId: string; turnId: string; token: string };
  decisions: Map<string, (approved: boolean) => void>;
};
const sessions = new Map<string, Session>();
// Matches the default Core worker concurrency; admission applies before Chromium allocation.
const MAX_HOSTS = 8;
const IDLE_MS = 120_000;
const keyOf = (turnId: string, callId: string) => `${turnId}:${callId}`;

async function closeSession(session: Session) {
  if (sessions.get(session.conversationId) === session) sessions.delete(session.conversationId);
  for (const resolve of session.decisions.values()) resolve(false);
  session.decisions.clear();
  await session.host.then(
    (host) => host.close(),
    () => {},
  );
  await sql`UPDATE assistant.artifact_agent_calls SET status='lost',updated_at=now()
    WHERE host_id=${session.id}::uuid AND status='running'`;
}

async function authorize(context: CodeToolContext, turnId: string) {
  if (context.actor.kind !== "user" || !context.conversationId) throw new Error("Code host requires a user conversation");
  const conversation = await aiConversations.getConversation({
    conversationId: context.conversationId,
    ownerUserId: context.actor.user.id,
  });
  const active = await aiConversations.getActiveTurn({ conversationId: context.conversationId });
  if (
    !conversation ||
    conversation.archivedAt ||
    !active ||
    active.turn.id !== turnId ||
    active.turn.cancelRequestedAt ||
    !["running", "waiting_for_action"].includes(active.turn.status)
  )
    throw new Error("The code host's conversation turn is no longer active");
  return context.actor.user;
}

async function hostFetch(context: CodeToolContext, session: Session, path: string, init?: RequestInit): Promise<Response> {
  if (context.actor.kind !== "user" || !context.conversationId) throw new Error("User required");
  const active = await aiConversations.getActiveTurn({ conversationId: context.conversationId });
  if (!active || active.turn.cancelRequestedAt || (session.busy.size && session.lastCall?.turnId !== active.turn.id))
    throw new Error("Conversation is no longer active");
  await authorize(context, active.turn.id);
  const url = new URL(path, "http://localhost");
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
  const router = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", context.actor);
      c.set("accessSubject", context.accessSubject);
      await next();
    })
    .route(
      "/api/assistant/artifacts",
      createArtifactServiceRoutes(() => ({ transport: session.capabilityTransport, origin: "assistant", locale: context.locale, signal: init?.signal ?? undefined })),
    );
  return router.fetch(new Request(url, init));
}

async function createSession(context: CodeToolContext): Promise<Session> {
  if (!context.conversationId) throw new Error("Conversation required");
  const existing = sessions.get(context.conversationId);
  if (existing) return existing;
  if (sessions.size >= MAX_HOSTS) throw new Error("Code hosts are busy. Retry after a current run finishes.");
  const session: Session = {
    phase: "starting",
    id: crypto.randomUUID(),
    conversationId: context.conversationId,
    lastUsed: Date.now(),
    busy: new Set(),
    decisions: new Map(),
    capabilityTransport: createCodeCapabilityTransport(() => {
      if (!session.capabilityContext) throw new Error("Code capability authority expired");
      return session.capabilityContext;
    }),
    host: Promise.resolve().then(() =>
      createCliCodeHost(
        { fetch: (path, init) => hostFetch(context, session, String(path), init) },
        async (approval) => {
          if (!session.lastCall) throw new Error("Approval has no originating code call");
          const { turnId, callId } = session.lastCall;
          const id = z.uuid().parse(approval.id);
          await sql`INSERT INTO assistant.artifact_agent_approvals(turn_id,call_id,id,message)
      VALUES(${turnId}::uuid,${callId},${id}::uuid,${approvalMessage(approval)}) ON CONFLICT DO NOTHING`;
          const approved = await new Promise<boolean>((resolve) => session.decisions.set(id, resolve));
          session.decisions.delete(id);
          return { approved };
        },
        process.env.NODE_ENV === "production"
          ? { entry: new URL("./assistant-code-host-process.js", import.meta.url).pathname }
          : undefined,
      ),
    ),
  };
  sessions.set(context.conversationId, session);
  void session.host.then(
    () => {
      session.phase = "running";
    },
    () => {},
  );
  return session;
}

function approvalMessage(approval: CodeApproval) {
  // Trusted runtime review; no secret values are contained in this object.
  return `Code execution requests approval:\n${JSON.stringify(approval)}`;
}

export const agentHost = {
  async call(call: Call, context: CodeToolContext) {
    const user = await authorize(context, call.turnId);
    const input = parseCodeToolInput(call.name, call.args);
    const key = keyOf(call.turnId, call.callId);
    let [row] = await sql<
      { host_id: string; input: unknown; status: string; result: unknown }[]
    >`SELECT host_id,input,status,result FROM assistant.artifact_agent_calls
      WHERE turn_id=${call.turnId}::uuid AND call_id=${call.callId} AND user_id=${user.id}::uuid`;
    if (row && !isDeepStrictEqual(row.input, input)) throw new Error("Code call input changed; no replay performed");
    let session = sessions.get(context.conversationId!);
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
      session = await createSession(context);
      if (context.capabilityToken)
        session.capabilityContext = { conversationId: context.conversationId!, turnId: call.turnId, token: context.capabilityToken };
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
        void owned.host
          .then((host) =>
            host.execute({
              name: call.name,
              args: call.args,
              callId: call.callId,
              turnId: call.turnId,
              conversationId: context.conversationId!,
            }),
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
          .finally(() => {
            owned.busy.delete(key);
            owned.lastUsed = Date.now();
          });
      } else session.busy.delete(key);
      return { status: "running", phase: session.phase, approvals: [] };
    }
    if (session && context.capabilityToken)
      session.capabilityContext = { conversationId: context.conversationId!, turnId: call.turnId, token: context.capabilityToken };
    if (session)
      await sql`INSERT INTO assistant.artifact_agent_approvals(turn_id,call_id,id,message)
      SELECT ${call.turnId}::uuid,${call.callId},a.id,a.message FROM assistant.artifact_agent_approvals a
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
    const approvals = await sql<
      { id: string; message: string; decision: boolean | null }[]
    >`SELECT id,message,decision FROM assistant.artifact_agent_approvals WHERE turn_id=${call.turnId}::uuid AND call_id=${call.callId} ORDER BY ordinal`;
    return {
      status: row.status,
      phase: approvals.some((approval) => approval.decision === null) ? "waiting_for_user" : session?.phase,
      result: row.result,
      approvals,
    };
  },
  async sweep() {
    for (const session of sessions.values()) {
      const active = await aiConversations.getActiveTurn({ conversationId: session.conversationId });
      if (active?.turn.cancelRequestedAt || (session.busy.size && session.lastCall?.turnId !== active?.turn.id) ||
        (!active && Date.now() - session.lastUsed > IDLE_MS)) await closeSession(session);
      else {
        try {
          await (await session.host).health();
        } catch {
          await closeSession(session);
        }
      }
    }
  },
  async close() {
    await Promise.all([...sessions.values()].map(closeSession));
  },
};
