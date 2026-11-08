import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { getApp } from "../_internal/registry";
import {
  capabilityIdempotencyKeyHash,
  capabilityRequestHash,
  claimCapabilityIdempotency,
  completeCapabilityClaim,
  markCapabilityClaimUncertain,
} from "../capabilities/claims";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { issueInvocationToken as signInvocationToken } from "../services/identity/issue-invocation";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { LOCALE_HEADER } from "../shared/locale";
import { resolveAiCapabilityActor } from "./capability-execution";
import { authorizeCodeExecution } from "./code-execution";
import { CODE_SOURCE_TOOLS, type CodeSourceToolName } from "./code-source-contracts";
import { aiConversations } from "./store";
import { defineAiTool } from "./tools";

const DATABASE_TOOLS = new Set<CodeSourceToolName>([
  "code_sql",
  "code_database",
  "code_database_read",
  "code_database_export",
  "code_database_clear",
  "code_database_reset",
]);

const WRITE_TOOLS = new Set([
  "code_create",
  "code_write",
  "code_import",
  "code_remove",
  "code_update",
  "code_fork",
  "code_publish",
  "code_restore",
  "code_database_export",
  "code_database",
  ...Object.entries(CODE_SOURCE_TOOLS)
    .filter(([, definition]) => "review" in definition && definition.review)
    .map(([name]) => name),
]);

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
    promptHint: "promptHint" in definition ? definition.promptHint : undefined,
  }).server(async (input, context) => {
    if (!context.conversationId) throw new Error("Code tools require an Assistant conversation.");
    const conversationId = context.conversationId;
    const authority = await resolveAiCapabilityActor({
      conversationId: context.conversationId,
      persistedActor: context.actor,
      store: aiConversations,
    });
    const { actor } = authority;
    const authorizeDatabase = async () => {
      if (!DATABASE_TOOLS.has(name)) return;
      if (!context.turnId) throw new Error("Database tools require an active Assistant turn.");
      await authorizeCodeExecution(conversationId, context.turnId, actor.user.id);
    };
    await authorizeDatabase();
    const app = await getApp("assistant");
    if (!app) throw new Error("Assistant is unavailable.");
    const signal = context.signal;
    const send = async (review = false) => {
      await authorizeDatabase();
      const signed = await withActiveIdentitySigner(
        "invocation",
        (signer, db) =>
          signInvocationToken(
            {
              targetAppId: "assistant",
              callingAppId: "core",
              operation: `tool:${name}`,
              schemaHash: null,
              authority: invocationAuthorityFromRequest(authority),
              signer,
              issuer: signer.issuer,
            },
            { db, groupsAdmin: signer.groupsAdmin },
          ),
        { signal, timeoutMs: 5000 },
      );
      const headers = new Headers({ authorization: `Bearer ${signed.token}`, "content-type": "application/json" });
      if (context.locale) headers.set(LOCALE_HEADER, context.locale);
      const response = await fetch(new URL(`/_internal/assistant/tools/${name}`, app.baseUrl), {
        method: "POST",
        headers,
        redirect: "manual",
        signal,
        body: JSON.stringify({ input, conversationId: context.conversationId, ...(review ? { review: true } : {}) }),
      });
      const parsed = await readBoundedJson(response, 256 * 1024);
      if (!parsed.ok) throw new Error("Invalid Assistant tool response. A write may have completed; inspect its state before retrying.");
      const reply = Reply.safeParse(parsed.data);
      if (!reply.success) throw new Error("Assistant tool request failed. Inspect resource state before retrying a write.");
      if (!reply.data.ok) throw new Error(`${reply.data.error.code}: ${reply.data.error.message}`);
      if (!response.ok) throw new Error("Assistant tool request failed.");
      return { data: reply.data.data, status: response.status };
    };
    if ("review" in definition && definition.review) {
      const preview = z.object({ data: z.object({ message: z.string().min(1) }) }).parse((await send(true)).data).data;
      if (!(await context.requestApproval(preview.message))) throw new Error("The user declined this change. No mutation was sent.");
      await authorizeDatabase();
    }
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
      const response = await send();
      if (claim) await completeCapabilityClaim(claim, response.status, response.data);
      return response.data;
    } catch (error) {
      if (claim) await markCapabilityClaimUncertain(claim);
      throw error;
    }
  });
}

/** Implicit chat discovery exposes only chat/Project files; Studio uses explicit direct tools. */
export const createCodeSourceTools = () => [
  createCodeSourceTool("code_files"),
  createCodeSourceTool("code_file_stat"),
  createCodeSourceTool("code_file_copy"),
];
