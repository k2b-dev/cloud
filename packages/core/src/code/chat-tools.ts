import { type AiRuntimeTool, aiConversations, defineAiTool, resolveAiCapabilityActor } from "@k2b/cloud/ai";
import { REQUEST_IDLE_TIMEOUT_MAX_SECONDS } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { z } from "zod";
import { codeAuthoringFailure } from "../api/code-authoring";
import { type CodeContext, CodeDataError, requireCodePermission } from "./access";
import { codeAuthoringServices } from "./authoring";
import { CODE_AUTHORING_REQUEST_BYTES, CodeAuthoringErrorSchema, codeAuthoringContracts } from "./authoring-contracts";
import { CodeSourceFilesSchema } from "./contracts";
import { readCode } from "./store";

type ServerTool = Extract<AiRuntimeTool, { location: "server" }>;
type ChatContext = Omit<Parameters<ServerTool["run"]>[1], "reportResult">;
/** Core supplies the schemas and services; the platform knows no Core application contracts. */
export function createCodeAuthoringChatTools() {
  async function contextFor(context: ChatContext, codeId?: string): Promise<CodeContext> {
    if (!context.conversationId || !context.turnId) throw new CodeDataError("FORBIDDEN", "Code authoring requires an active chat turn.");
    const run = await aiConversations.getTurnRunConfig({ conversationId: context.conversationId, turnId: context.turnId });
    if (!run || run.kind === "compact" || run.background || run.mandate)
      throw new CodeDataError("FORBIDDEN", "Edit lasting Code in an interactive chat.");
    const authority = await resolveAiCapabilityActor({
      conversationId: context.conversationId,
      persistedActor: context.actor,
      store: aiConversations,
    });
    const result: CodeContext = { authority, locale: context.locale, signal: context.signal, requestId: context.callId };
    if (codeId) await requireCodePermission((await readCode(codeId, result)).code, result, true);
    return result;
  }
  async function call<I extends object, O>(
    service: (input: I, context: CodeContext) => Promise<O>,
    input: I,
    context: ChatContext,
  ): Promise<O> {
    if (Buffer.byteLength(JSON.stringify(input)) > CODE_AUTHORING_REQUEST_BYTES)
      throw new CodeDataError("BAD_INPUT", "Code request exceeds the checker budget.");
    const codeId = "codeId" in input && typeof input.codeId === "string" ? input.codeId : undefined;
    return service(input, await contextFor(context, codeId));
  }
  const safe = async <T>(
    run: () => Promise<T>,
    context: ChatContext,
    command: string,
  ): Promise<T | z.infer<typeof CodeAuthoringErrorSchema>> => {
    try {
      return await run();
    } catch (error) {
      // Preserve the exact CLI failure, including stale-version comparison details.
      context.signal.throwIfAborted();
      const failure = codeAuthoringFailure(error);
      if (failure.status === 500)
        logger("core:code-authoring").error("Code authoring chat command failed", {
          command,
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : "unknown",
        });
      return failure.body;
    }
  };
  function tool<I extends z.ZodType<object>, O extends z.ZodType>(
    command: string,
    contract: { input: I; data: O },
    service: (input: z.output<I>, context: CodeContext) => Promise<z.output<O>>,
    description: string,
  ) {
    const outputSchema: z.ZodType = z.union([contract.data, CodeAuthoringErrorSchema]);
    return defineAiTool({
      name: `code_${command}`,
      description,
      inputSchema: contract.input,
      outputSchema,
      approval: "never",
      timeoutMs: REQUEST_IDLE_TIMEOUT_MAX_SECONDS * 1000,
    }).server((input, context) => safe(() => call(service, input, context), context, command));
  }
  const write = z
    .object({
      project: codeAuthoringContracts.pull.data.describe("Complete project returned by code_init, code_pull or the previous Code write."),
      path: CodeSourceFilesSchema.keyType,
      content: z.string(),
    })
    .strict();
  return [
    tool(
      "init",
      codeAuthoringContracts.init,
      codeAuthoringServices.init,
      "Create lasting personal Code or Code for an owner you administer. Returns code.json metadata and initial code.ts. Nothing runs.",
    ),
    tool(
      "pull",
      codeAuthoringContracts.pull,
      codeAuthoringServices.pull,
      "Read the latest saved Code into a complete editable project: config with baseVersionId and exact files. Code editor rights required. Preserve baseVersionId through submit; on conflict pull and reconcile.",
    ),
    tool(
      "sdk",
      codeAuthoringContracts.sdk,
      codeAuthoringServices.sdk,
      "Read this Code's generated @sdk types, runtime and manifest from the live authorized catalog. Resource handles accept dynamic IDs; review records their type, and each call checks current access.",
    ),
    tool(
      "test",
      codeAuthoringContracts.test,
      codeAuthoringServices.test,
      "Check Code and run its test/**/*.json fixtures with fictional data in the production sandbox. Returns the exact cld code test JSON, including ordered calls. No real capabilities or durable runs.",
    ),
    tool(
      "simulate",
      codeAuthoringContracts.simulate,
      codeAuthoringServices.simulate,
      "Check Code and simulate exactly one fixture invocation with a fixed clock and seed and explicit fake replies. Returns the exact cld code simulate JSON. No real effects.",
    ),
    tool(
      "submit",
      codeAuthoringContracts.submit,
      codeAuthoringServices.submit,
      "Check and submit the complete Code files against baseVersionId from pull/init. Pass the test/**/*.json fixtures as tests: Core runs them and shows the result to reviewers. Returns an immutable version for human review. Does not activate: the chat shows the person a card with the rights and who can switch it on, also possible in the UI or CLI. On unknown outcome pull before retrying.",
    ),
    tool(
      "diff",
      codeAuthoringContracts.diff,
      codeAuthoringServices.diff,
      "Read complete file rows and permissions for a submitted Code version, identical to cld code diff. Requires editor rights in the chat.",
    ),
    tool(
      "read",
      codeAuthoringContracts.pull,
      codeAuthoringServices.pull,
      "Read lasting Code with {codeId}, returning the complete editable project, as code_pull. Editor rights required.",
    ),
    defineAiTool({
      name: "code_write",
      description:
        "Edit one lasting Code file with {project,path,content}. Pass the complete project from init/pull/previous write. Returns a replacement project; retain it for check/test/submit. This draft is only in the chat until submit saves an immutable version.",
      inputSchema: write,
      outputSchema: z.unknown(),
      approval: "never",
    }).server((draft, context) =>
      safe(
        async () => {
          await contextFor(context, draft.project.config.codeId);
          const project = { ...draft.project, files: { ...draft.project.files, [draft.path]: draft.content } };
          if (Buffer.byteLength(JSON.stringify(project)) > CODE_AUTHORING_REQUEST_BYTES)
            throw new CodeDataError("BAD_INPUT", "Code project exceeds the checker budget.");
          return codeAuthoringContracts.pull.data.parse(project);
        },
        context,
        "write",
      ),
    ),
    tool(
      "check",
      codeAuthoringContracts.check,
      codeAuthoringServices.check,
      "Check lasting Code with {codeId,files,entry}. Returns diagnostics and operation/target permissions at file/line locations. Fix errors before test and submit.",
    ),
  ];
}
