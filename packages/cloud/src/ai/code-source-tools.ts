import { z } from "zod";
import {
  capabilityIdempotencyKeyHash,
  capabilityRequestHash,
  claimCapabilityIdempotency,
  completeCapabilityClaim,
  markCapabilityClaimUncertain,
} from "../capabilities/claims";
import { getApp } from "../_internal/registry";
import { readBoundedJson } from "../_internal/bounded-json";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { signInvocationToken } from "../services/identity/invocation-token";
import { LOCALE_HEADER } from "../shared/locale";
import { CODE_SOURCE_TOOLS, type CodeSourceToolName } from "./code-source-contracts";
import { resolveAiCapabilityActor } from "./capability-execution";
import { aiConversations } from "./store";
import { defineAiTool } from "./tools";

const WRITE_TOOLS = new Set(["code_create", "code_write", "code_remove", "code_update", "code_fork", "code_publish", "code_restore"]);

const Reply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

/** Direct server tools: discovery exposes code_*; Assistant owns the resource services. */
export function createCodeSourceTool(name: CodeSourceToolName) {
  const definition = CODE_SOURCE_TOOLS[name];
  return defineAiTool({
    name,
    description:
      definition.description +
      (WRITE_TOOLS.has(name) ? " If a write has an unknown outcome, inspect current state before attempting another write." : ""),
    inputSchema: definition.input,
    outputSchema: z.unknown(),
    approval: "never",
  }).server(async (input, context) => {
    if (!context.conversationId) throw new Error("Code tools require an Assistant conversation.");
    const { actor } = await resolveAiCapabilityActor({
      conversationId: context.conversationId,
      persistedActor: context.actor,
      store: aiConversations,
    });
    const app = await getApp("assistant");
    if (!app) throw new Error("Assistant is unavailable.");
    const signal = context.signal;
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
      { signal, timeoutMs: 5000 },
    );
    const headers = new Headers({ authorization: `Bearer ${signed.token}`, "content-type": "application/json" });
    if (context.locale) headers.set(LOCALE_HEADER, context.locale);
    // Reuse the platform replay guard; these tools are not registered capabilities.
    const claim = WRITE_TOOLS.has(name)
      ? {
          appId: "assistant",
          capability: `tool:${name}`,
          principal: `user:${actor.user.id}`,
          keyHash: capabilityIdempotencyKeyHash(`${context.conversationId}:${context.callId}`),
        }
      : null;
    if (claim) {
      if (!context.callId) throw new Error("A write requires a tool call ID.");
      const state = await claimCapabilityIdempotency(claim, capabilityRequestHash(input));
      if (state.state === "replay")
        throw new Error("This write already completed. Use code_list or code_read to inspect current state; do not repeat the write.");
      if (state.state !== "claimed")
        throw new Error(`Write outcome ${state.state}; inspect current state before attempting another write.`);
    }
    try {
      const response = await fetch(new URL(`/_internal/assistant/tools/${name}`, app.baseUrl), {
        method: "POST",
        headers,
        redirect: "manual",
        signal,
        body: JSON.stringify({ input, conversationId: context.conversationId }),
      });
      const parsed = await readBoundedJson(response, 256 * 1024);
      if (!parsed.ok) throw new Error("Invalid Assistant tool response. A write may have completed; inspect its state before retrying.");
      const reply = Reply.safeParse(parsed.data);
      if (!reply.success) throw new Error("Assistant tool request failed. Inspect resource state before retrying a write.");
      if (!reply.data.ok) throw new Error(`${reply.data.error.code}: ${reply.data.error.message}`);
      if (!response.ok) throw new Error("Assistant tool request failed.");
      if (claim) await completeCapabilityClaim(claim, response.status, reply.data.data);
      return reply.data.data;
    } catch (error) {
      if (claim) await markCapabilityClaimUncertain(claim);
      throw error;
    }
  });
}

export const createCodeSourceTools = () => [
  createCodeSourceTool("code_actions"),
  createCodeSourceTool("code_sql"),
  createCodeSourceTool("code_versions"),
  createCodeSourceTool("code_list"),
  createCodeSourceTool("code_read"),
  createCodeSourceTool("code_history"),
  createCodeSourceTool("code_fork"),
  createCodeSourceTool("code_publish"),
  createCodeSourceTool("code_restore"),
  createCodeSourceTool("code_update"),
  createCodeSourceTool("code_create"),
  createCodeSourceTool("code_write"),
  createCodeSourceTool("code_remove"),
];
