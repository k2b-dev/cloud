import { z } from "zod";
import type { ToolContext } from "@k2b/nessi";
import type { RequestActor } from "../server";
import { getApp } from "../_internal/registry";
import { readBoundedJson } from "../_internal/bounded-json";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { signInvocationToken } from "../services/identity/invocation-token";
import { LOCALE_HEADER } from "../shared/locale";
import { resolveAiCapabilityActor } from "./capability-execution";
import { aiConversations } from "./store";

const Reply = z.object({
  ok: z.literal(true),
  data: z.object({
    status: z.enum(["running", "busy", "done", "lost"]),
    phase: z.enum(["starting", "running", "busy", "waiting_for_user"]).optional(),
    result: z.unknown().optional(),
    approvals: z.array(z.object({ id: z.uuid(), message: z.string(), decision: z.boolean().nullable() })),
  }),
});
type Context = ToolContext & {
  actor: RequestActor;
  conversationId?: string;
  turnId?: string;
  locale?: string;
  reportProgress?: (message: string) => Promise<void>;
};

/** The tab only renders progress and approvals; server calls own all execution and resumption. */
export const runManagedCodeTool =
  (name: string) =>
  async (args: unknown, context: Context): Promise<z.infer<ReturnType<typeof z.json>>> => {
    if (!context.conversationId || !context.turnId) throw new Error("Code execution requires an active Assistant turn");
    const { actor } = await resolveAiCapabilityActor({
      conversationId: context.conversationId,
      persistedActor: context.actor,
      store: aiConversations,
    });
    await context.reportProgress?.(context.locale?.startsWith("de") ? "Ausführungshost verbinden" : "Connecting execution host");
    const app = await getApp("assistant");
    if (!app) throw new Error("Assistant code host is unavailable");
    const request = async (decision?: { id: string; approved: boolean }) => {
      const signed = await withActiveIdentitySigner(
        "invocation",
        (signer) =>
          signInvocationToken({
            targetAppId: "assistant",
            callingAppId: "core",
            operation: `tool:${name}`,
            schemaHash: null,
            authority: {
              sub: actor.user.id,
              principal_type: "user",
              access_subject_type: "user",
              access_subject_id: actor.user.id,
              credential_kind: "session",
              scopes: [],
            },
            signer,
            issuer: signer.issuer,
          }),
        { signal: context.signal, timeoutMs: 5000 },
      );
      const headers = new Headers({ authorization: `Bearer ${signed.token}`, "content-type": "application/json" });
      if (context.locale) headers.set(LOCALE_HEADER, context.locale);
      const response = await fetch(new URL(`/_internal/assistant/tools/${name}`, app.baseUrl), {
        method: "POST",
        headers,
        redirect: "manual",
        signal: context.signal,
        body: JSON.stringify({
          conversationId: context.conversationId,
          input: { turnId: context.turnId, callId: context.callId, name, args, ...(decision ? { decision } : {}) },
        }),
      });
      const body = await readBoundedJson(response, 256 * 1024);
      if (!body.ok || !response.ok)
        throw new Error("Code host request failed; inspect the existing call before starting another execution");
      return Reply.parse(body.data).data;
    };
    return waitForManagedCodeCall(request, context);
  };

/** Ordered reviews are replayed through Nessi before consuming a durable result. */
export async function waitForManagedCodeCall(
  request: (decision?: { id: string; approved: boolean }) => Promise<z.infer<typeof Reply>["data"]>,
  context: Pick<ToolContext, "signal" | "requestApproval"> & { locale?: string; reportProgress?: (message: string) => Promise<void> },
): Promise<z.infer<ReturnType<typeof z.json>>> {
  const seen = new Set<string>();
  let lastPhase: string | undefined;
  while (true) {
    context.signal.throwIfAborted();
    const state = await request();
    if (state.phase && state.phase !== lastPhase) {
      lastPhase = state.phase;
      const labels = context.locale?.startsWith("de")
        ? {
            starting: "Ausführungshost startet",
            running: "Code wird ausgeführt",
            busy: "Wartet auf laufende Ausführung",
            waiting_for_user: "Wartet auf Freigabe",
          }
        : {
            starting: "Starting execution host",
            running: "Executing code",
            busy: "Waiting for current execution",
            waiting_for_user: "Waiting for approval",
          };
      await context.reportProgress?.(labels[state.phase]);
    }
    // Replay the same ordered approval history when Nessi resumes this server tool.
    // Skipping already resolved reviews would shift Nessi's child action IDs.
    for (const approval of state.approvals) {
      if (seen.has(approval.id)) continue;
      const approved = await context.requestApproval(approval.message);
      seen.add(approval.id);
      if (approval.decision === null) await request({ id: approval.id, approved });
    }
    if (state.status === "done") return z.json().parse(state.result);
    if (state.status === "lost")
      throw new Error("The isolated code host was lost. The call was not replayed; inspect saved data before starting a new run.");
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        clearTimeout(timer);
        reject(context.signal.reason);
      };
      const timer = setTimeout(() => {
        context.signal.removeEventListener("abort", aborted);
        resolve();
      }, 250);
      context.signal.addEventListener("abort", aborted, { once: true });
      if (context.signal.aborted) aborted();
    });
  }
}
