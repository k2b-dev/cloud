import type { ToolContext } from "@k2b/nessi";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { getApp } from "../_internal/registry";
import type { RequestActor } from "../server";
import { IDENTITY_REFRESH_TIMEOUT_MS } from "../services/identity/constants";
import { signInvocationToken } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { logger } from "../services/logging";
import { LOCALE_HEADER } from "../shared/locale";
import { TIMEZONE_COOKIE } from "../shared/time";
import { CodeToolFailure } from "./browser-code-contracts";
import { resolveAiCapabilityActor } from "./capability-execution";
import { CODE_CAPABILITY_TOKEN_HEADER, codeCapabilityOperation } from "./code-capability-transport";
import { authorizeCodeExecution } from "./code-execution";
import { aiConversations } from "./store";
import type { AiApprovalTarget, AiWebsiteReceipt } from "./types";

const log = logger("ai:code-runtime");
const ISSUANCE_TIMEOUT_MS = 5_000;

const Reply = z.object({
  ok: z.literal(true),
  data: z.object({
    status: z.enum(["running", "busy", "done", "lost"]),
    phase: z.enum(["starting", "running", "busy", "waiting_for_user"]).optional(),
    result: z.unknown().optional(),
    approvals: z.array(
      z.object({
        id: z.uuid(),
        message: z.string(),
        decision: z.boolean().nullable(),
        /** What the person may remember: the website or Action, derived by the host from the stored request. */
        remember: z.object({ toolName: z.string(), approvalScope: z.string(), always: z.boolean() }).optional(),
      }),
    ),
    /** The next requests a website approval for this chat let through without asking, after `receiptsAfter`. */
    receipts: z.array(z.object({ method: z.string(), url: z.string() })).default([]),
    /** More receipts follow; the answer then leaves out the result until the last one is read. */
    moreReceipts: z.boolean().default(false),
  }),
});
type Context = ToolContext & {
  actor: RequestActor;
  conversationId?: string;
  turnId?: string;
  locale?: string;
  timeZone?: string;
  reportProgress?: (message: string) => Promise<void>;
  requestApprovalFor?: (message: string, target: AiApprovalTarget) => Promise<boolean>;
  reportWebsiteReceipts?: (receipts: AiWebsiteReceipt[]) => Promise<void>;
};

/** The tab only renders progress and approvals; server calls own all execution and resumption. */
export const runManagedCodeTool =
  (name: string) =>
  async (args: unknown, context: Context): Promise<z.infer<ReturnType<typeof z.json>>> => {
    if (!context.conversationId || !context.turnId) throw new Error("Code execution requires an active Assistant turn");
    const runConfig = await aiConversations.getTurnRunConfig({ conversationId: context.conversationId, turnId: context.turnId });
    if (!runConfig || runConfig.kind === "compact" || Boolean(runConfig.background) !== Boolean(runConfig.mandate)) {
      throw new Error("Code execution requires a valid turn and task-scoped background authority.");
    }
    const { actor } = await resolveAiCapabilityActor({
      conversationId: context.conversationId,
      persistedActor: context.actor,
      store: aiConversations,
    });
    await authorizeCodeExecution(context.conversationId, context.turnId, actor.user.id);
    await context.reportProgress?.(context.locale?.startsWith("de") ? "Ausführungshost verbinden" : "Connecting execution host");
    const app = await getApp("assistant");
    if (!app) throw new Error("Assistant code host is unavailable");
    const issue = async (audience: { targetAppId: string; callingAppId: string; operation: string }) => {
      // A token is signed before its request goes out, so a timed-out issuance
      // never reached the host and is safe to repeat. Retry long enough for a
      // stalled shared refresh to finish or fall back to the cached key. Every
      // timeout used up a full attempt or ended a shared load, so this cannot spin.
      const giveUpAt = Date.now() + IDENTITY_REFRESH_TIMEOUT_MS + ISSUANCE_TIMEOUT_MS;
      while (true) {
        try {
          return await withActiveIdentitySigner(
            "invocation",
            (signer) =>
              signInvocationToken({
                ...audience,
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
            { signal: context.signal, timeoutMs: ISSUANCE_TIMEOUT_MS },
          );
        } catch (error) {
          if (context.signal.aborted || !(error instanceof DOMException && error.name === "TimeoutError")) throw error;
          if (Date.now() < giveUpAt) continue;
          log.warn("Code call gave up on identity issuance", { tool: name, error: error.message });
          throw new Error(
            context.locale?.startsWith("de")
              ? "Der Identitätsdienst hat nicht rechtzeitig geantwortet. Prüfe, ob dieser Aufruf schon gestartet ist, bevor du ihn erneut ausführst."
              : "The identity service did not respond in time. Check whether this call already started before running it again.",
            { cause: error },
          );
        }
      }
    };
    // Polls run every 250 ms for as long as the code runs. Reuse both tokens
    // while they stay valid for at least 10 s, so a long run or an approval
    // round trip does not depend on a fresh issuance for every poll.
    const usable = (token: Awaited<ReturnType<typeof signInvocationToken>> | undefined) =>
      token && token.claims.exp * 1000 - Date.now() >= 10_000 ? token : undefined;
    let signed: Awaited<ReturnType<typeof signInvocationToken>> | undefined;
    let callback: Awaited<ReturnType<typeof signInvocationToken>> | undefined;
    const request = async ({ decision, receiptsAfter }: { decision?: { id: string; approved: boolean }; receiptsAfter: number }) => {
      context.signal.throwIfAborted();
      await authorizeCodeExecution(context.conversationId!, context.turnId!, actor.user.id);
      signed = usable(signed) ?? (await issue({ targetAppId: "assistant", callingAppId: "core", operation: `tool:${name}` }));
      callback =
        usable(callback) ??
        (await issue({
          targetAppId: "core",
          callingAppId: "assistant",
          operation: codeCapabilityOperation(context.conversationId!, context.turnId!),
        }));
      const headers = new Headers({ authorization: `Bearer ${signed.token}`, "content-type": "application/json" });
      headers.set(CODE_CAPABILITY_TOKEN_HEADER, callback.token);
      if (context.locale) headers.set(LOCALE_HEADER, context.locale);
      const timeZone = runConfig.timeZone ?? context.timeZone;
      headers.set(
        "cookie",
        [`theme=${runConfig.theme ?? "light"}`, ...(timeZone ? [`${TIMEZONE_COOKIE}=${encodeURIComponent(timeZone)}`] : [])].join("; "),
      );
      const response = await fetch(new URL(`/_internal/assistant/tools/${name}`, app.baseUrl), {
        method: "POST",
        headers,
        redirect: "manual",
        signal: context.signal,
        body: JSON.stringify({
          conversationId: context.conversationId,
          input: { turnId: context.turnId, callId: context.callId, name, args, receiptsAfter, ...(decision ? { decision } : {}) },
        }),
      });
      const body = await readBoundedJson(response, 256 * 1024);
      if (!body.ok || !response.ok)
        throw new Error("Code host request failed; inspect the existing call before starting another execution");
      return Reply.parse(body.data).data;
    };
    const backgroundApproval = async (): Promise<boolean> => {
      throw new Error("Background code cannot request interactive approval. Update task grants in the normal chat.");
    };
    return waitForManagedCodeCall(
      request,
      runConfig.background ? { ...context, requestApproval: backgroundApproval, requestApprovalFor: backgroundApproval } : context,
    );
  };

/**
 * Ordered reviews are replayed through Nessi before consuming a durable result. Each request a website approval let
 * through is reported as a receipt as soon as the host names it, so the chat shows it with its full URL whatever the
 * run's outcome. Receipts arrive page by page after the ones already reported.
 */
export async function waitForManagedCodeCall(
  request: (input: { decision?: { id: string; approved: boolean }; receiptsAfter: number }) => Promise<z.input<typeof Reply>["data"]>,
  context: Pick<ToolContext, "signal" | "requestApproval"> & {
    locale?: string;
    reportProgress?: (message: string) => Promise<void>;
    requestApprovalFor?: (message: string, target: AiApprovalTarget) => Promise<boolean>;
    reportWebsiteReceipts?: (receipts: AiWebsiteReceipt[]) => Promise<void>;
  },
): Promise<z.infer<ReturnType<typeof z.json>>> {
  const seen = new Set<string>();
  let lastPhase: string | undefined;
  let receiptsAfter = 0;
  while (true) {
    context.signal.throwIfAborted();
    const state = Reply.shape.data.parse(await request({ receiptsAfter }));
    if (state.receipts.length) {
      await context.reportWebsiteReceipts?.(state.receipts.map((receipt, index) => ({ index: receiptsAfter + index, ...receipt })));
      receiptsAfter += state.receipts.length;
    }
    if (state.moreReceipts) continue;
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
      const approved =
        approval.remember && context.requestApprovalFor
          ? await context.requestApprovalFor(approval.message, approval.remember)
          : await context.requestApproval(approval.message);
      seen.add(approval.id);
      if (approval.decision === null) await request({ decision: { id: approval.id, approved }, receiptsAfter });
    }
    if (state.status === "done") {
      // Nessi records a thrown error as a failed tool result the model can act on.
      const failure = CodeToolFailure.safeParse(state.result);
      if (failure.success) throw new Error([failure.data.error, failure.data.guidance].filter(Boolean).join(" "));
      return z.json().parse(state.result);
    }
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
