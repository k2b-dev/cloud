import { type AiRuntimeTool, aiConversations, CODE_SOURCE_TOOLS, defineAiTool, resolveAiCapabilityActor } from "@k2b/cloud/ai";
import { CodeCheckInput } from "@k2b/cloud/ai/browser";
import { createCloudAiCodeTools, createCodeSourceTool } from "@k2b/cloud/ai/tools";
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
  function server(tool: AiRuntimeTool | undefined): ServerTool {
    if (!tool || !("location" in tool) || tool.location !== "server") throw new Error("Platform Code tool unavailable");
    return tool;
  }
  const legacyRead = server(createCodeSourceTool("code_read"));
  const legacyWrite = server(createCodeSourceTool("code_write"));
  const legacyCheck = server(createCloudAiCodeTools().find((item) => item.def.name === "code_check"));
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
      "Create lasting personal Code or Code for an owner you administer. Returns code.json metadata and initial code.ts. Nothing runs. Use code_create for a Studio HTML app.",
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
      "Read this Code's generated @sdk types, runtime and manifest from the live authorized catalog. Resource handles require literal IDs; code_run permits dynamic IDs.",
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
      "Check and submit the complete Code files against baseVersionId from pull/init. Returns an immutable version for human review. Does not activate: the chat shows the person a card with the rights and who can switch it on, also possible in the UI or CLI. On unknown outcome pull before retrying.",
    ),
    tool(
      "diff",
      codeAuthoringContracts.diff,
      codeAuthoringServices.diff,
      "Read complete file rows and permissions for a submitted Code version, identical to cld code diff. Requires editor rights in the chat.",
    ),
    defineAiTool({
      name: "code_read",
      promptHint: legacyRead.def.promptHint,
      description:
        legacyRead.def.description +
        "\n\nLasting Code: " +
        "Read lasting Code with {codeId}, returning the same project as code_pull (editor rights required). Read a Studio source file with {id,path}; its existing revision and paging contract applies.",
      inputSchema: CODE_SOURCE_TOOLS.code_read.input
        .partial()
        .extend({ codeId: codeAuthoringContracts.pull.input.shape.codeId.optional() })
        .refine(
          (input) =>
            input.codeId !== undefined
              ? input.id === undefined && input.path === undefined && input.revision === undefined
              : CODE_SOURCE_TOOLS.code_read.input.safeParse(input).success,
          "Provide codeId for Code or id for Studio",
        ),
      outputSchema: z.unknown(),
      approval: "never",
    }).server((input, context) => {
      const parsed = codeAuthoringContracts.pull.input.safeParse(input.codeId === undefined ? input : { codeId: input.codeId });
      return parsed.success
        ? safe(() => call(codeAuthoringServices.pull, parsed.data, context), context, "pull")
        : legacyRead.run(input, context);
    }),
    defineAiTool({
      name: "code_write",
      promptHint: legacyWrite.def.promptHint,
      description:
        legacyWrite.def.description +
        "\n\nLasting Code: " +
        "Edit one lasting Code file with {project,path,content}; pass the full project from init/pull/previous write. Returns a replacement project; retain it for later writes and send its files/config entry/codeId to check/test/submit. This draft is only in the chat until submit saves an immutable version. Studio writes use {id,path,content,expectedRevision} as before.",
      inputSchema: CODE_SOURCE_TOOLS.code_write.input
        .partial()
        .extend({
          project: write.shape.project.optional(),
          path: write.shape.path.optional(),
          content: write.shape.content.optional(),
        })
        .refine(
          (input) => write.safeParse(input).success || CODE_SOURCE_TOOLS.code_write.input.safeParse(input).success,
          "Provide a Code project or Studio id/revision with path and content",
        ),
      outputSchema: z.unknown(),
      approval: "never",
    }).server((input, context) => {
      const parsed = write.safeParse(input);
      if (!parsed.success) return legacyWrite.run(input, context);
      const draft = parsed.data;
      return safe(
        async () => {
          await contextFor(context, draft.project.config.codeId);
          const project = { ...draft.project, files: { ...draft.project.files, [draft.path]: draft.content } };
          if (Buffer.byteLength(JSON.stringify(project)) > CODE_AUTHORING_REQUEST_BYTES)
            throw new CodeDataError("BAD_INPUT", "Code project exceeds the checker budget.");
          return codeAuthoringContracts.pull.data.parse(project);
        },
        context,
        "write",
      );
    }),
    defineAiTool({
      name: "code_check",
      promptHint: legacyCheck.def.promptHint,
      description:
        legacyCheck.def.description +
        "\n\nLasting Code: " +
        "Check lasting Code with {codeId,files,entry}; returns the exact cld code check JSON with diagnostics and operation/target permissions at file/line locations, marked new/existing. Fix errors before test and submit. Studio HTML checks use {id} or {files} without codeId and retain their screenshot review workflow.",
      inputSchema: z
        .object({
          codeId: codeAuthoringContracts.check.input.shape.codeId.optional(),
          entry: z.string().optional(),
          id: CodeCheckInput.shape.id,
          files: z.union([CodeSourceFilesSchema, CodeCheckInput.shape.files]).optional(),
        })
        .strict()
        .refine(
          (input) => codeAuthoringContracts.check.input.safeParse(input).success || CodeCheckInput.safeParse(input).success,
          "Provide Code codeId/files/entry or Studio id/files",
        ),
      outputSchema: z.unknown(),
      approval: "never",
      timeoutMs: REQUEST_IDLE_TIMEOUT_MAX_SECONDS * 1000,
    }).server((input, context) => {
      const parsed = codeAuthoringContracts.check.input.safeParse(input);
      return parsed.success
        ? safe(() => call(codeAuthoringServices.check, parsed.data, context), context, "check")
        : legacyCheck.run(input, context);
    }),
  ];
}
