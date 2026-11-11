import { type AiRuntimeTool, aiConversations, defineAiTool, resolveAiCapabilityActor } from "@k2b/cloud/ai";
import { REQUEST_IDLE_TIMEOUT_MAX_SECONDS } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { z } from "zod";
import { codeAuthoringFailure } from "../api/code-authoring";
import { type CodeContext, CodeDataError, requireCodePermission } from "./access";
import { codeAuthoringServices } from "./authoring";
import {
  CODE_AUTHORING_REQUEST_BYTES,
  type CodeAuthoringData,
  CodeAuthoringErrorSchema,
  CodeChatDraftSummarySchema,
  codeAuthoringContracts,
  codeChatAuthoringInputs,
} from "./authoring-contracts";
import { type CodeChatDraftParts, codeChatDraftSummary, requireCodeChatDraft, updateCodeChatDraft } from "./chat-drafts";
import { CODE_CHAT_SDK_APPS, CodeChatSdkDataSchema, CodeChatSdkInputSchema, readCodeChatSdk } from "./chat-sdk";

import { readCode } from "./store";

type ServerTool = Extract<AiRuntimeTool, { location: "server" }>;
type ChatContext = Omit<Parameters<ServerTool["run"]>[1], "reportResult">;
const isFixture = (path: string) => path.startsWith("test/") && path.endsWith(".json");
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
    service: (input: I, context: CodeContext, chat: ChatContext) => Promise<O>,
    input: I,
    context: ChatContext,
  ): Promise<O> {
    if (Buffer.byteLength(JSON.stringify(input)) > CODE_AUTHORING_REQUEST_BYTES)
      throw new CodeDataError("BAD_INPUT", "Code request exceeds the checker budget.");
    const codeId = "codeId" in input && typeof input.codeId === "string" ? input.codeId : undefined;
    return service(input, await contextFor(context, codeId), context);
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
    service: (input: z.output<I>, context: CodeContext, chat: ChatContext) => Promise<z.output<O>>,
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
  function conversationId(context: ChatContext) {
    if (!context.conversationId) throw new CodeDataError("FORBIDDEN", "Code authoring requires an active chat turn.");
    return context.conversationId;
  }
  function remember<I>(service: (input: I, context: CodeContext) => Promise<CodeAuthoringData<"pull">>) {
    return async (input: I, context: CodeContext, chat: ChatContext) => {
      const project = await service(input, context);
      // init has no Code ID until creation; reads and writes always check editor rights for the concrete Code.
      await contextFor(chat, project.config.codeId);
      await updateCodeChatDraft(project.config.codeId, conversationId(chat), () => ({
        entry: project.config.entry,
        files: project.files,
        baseVersionId: project.config.baseVersionId,
        tests: {},
      }));
      return project;
    };
  }
  async function draftFor(
    input: {
      codeId: string;
      files?: Record<string, string>;
      entry?: string;
      tests?: Record<string, string>;
      baseVersionId?: string | null;
    },
    chat: ChatContext,
  ) {
    return updateCodeChatDraft(input.codeId, conversationId(chat), (current) => {
      const draft =
        current ??
        (input.files !== undefined
          ? { files: input.files, entry: input.entry ?? "code.ts", tests: {}, baseVersionId: input.baseVersionId ?? null }
          : requireCodeChatDraft(null));
      return {
        files: input.files ?? draft.files,
        entry: input.entry ?? draft.entry,
        tests: input.tests ?? draft.tests,
        baseVersionId: input.baseVersionId === undefined ? draft.baseVersionId : input.baseVersionId,
      };
    });
  }
  return [
    tool(
      "init",
      codeAuthoringContracts.init,
      remember(codeAuthoringServices.init),
      "Create lasting personal Code or Code for an owner you administer. Returns code.json metadata and initial code.ts. Initializes this chat's server-held draft. Nothing runs.",
    ),
    tool(
      "pull",
      codeAuthoringContracts.pull,
      remember(codeAuthoringServices.pull),
      "Read the latest saved Code into a complete editable project: config with baseVersionId and exact files. Code editor rights required. Resets this chat's server-held draft, including tests. On conflict pull and re-apply edits.",
    ),
    tool(
      "sdk",
      { input: CodeChatSdkInputSchema, data: CodeChatSdkDataSchema },
      readCodeChatSdk,
      `Read this Code's @sdk from the live authorized catalog in two steps. Without apps: an index of every app export, method path, policy row and automation event, one line each. Then with apps (at most ${CODE_CHAT_SDK_APPS} per call, [] for only the shared types): the TypeScript declarations of those apps plus app, page, db, http and event types. Resource handles accept dynamic IDs; review records their type, and each call checks current access.`,
    ),
    tool(
      "test",
      { input: codeChatAuthoringInputs.test, data: codeAuthoringContracts.test.data },
      async (input, context, chat) => {
        const draft = await draftFor(input, chat);
        return codeAuthoringServices.test({ ...input, files: draft.files, entry: draft.entry, tests: draft.tests }, context);
      },
      "With {codeId}, check the server-held draft and run its test/**/*.json fixtures written through code_write. Explicit files, entry or tests replace that draft part first. Run fixtures with fictional data in the production sandbox. Returns the exact cld code test JSON, including ordered calls. No real capabilities or durable runs.",
    ),
    tool(
      "simulate",
      { input: codeChatAuthoringInputs.simulate, data: codeAuthoringContracts.simulate.data },
      async (input, context, chat) => {
        const draft = await draftFor(input, chat);
        return codeAuthoringServices.simulate({ ...input, files: draft.files, entry: draft.entry }, context);
      },
      "With {codeId,fixture}, check the server-held draft and simulate exactly one fixture. Explicit files or entry replace that draft part first. Uses a fixture invocation with a fixed clock and seed and explicit fake replies. Returns the exact cld code simulate JSON. No real effects.",
    ),
    tool(
      "submit",
      { input: codeChatAuthoringInputs.submit, data: codeAuthoringContracts.submit.data },
      async (input, context, chat) => {
        const draft = await draftFor(input, chat);
        const result = await codeAuthoringServices.submit(
          {
            codeId: input.codeId,
            files: draft.files,
            entry: draft.entry,
            tests: draft.tests,
            baseVersionId: draft.baseVersionId,
          },
          context,
        );
        await updateCodeChatDraft(input.codeId, conversationId(chat), (current) => ({
          ...requireCodeChatDraft(current),
          baseVersionId: result.submission.version.id,
        }));
        return result;
      },
      "With {codeId}, check and submit the same server-held draft as code_check/code_test, including its baseVersionId and test fixtures as review evidence. Explicit files, entry, tests or baseVersionId replace that draft part first. Returns an immutable version for human review. Does not activate: the chat shows the person a card with the rights and who can switch it on, also possible in the UI or CLI. On unknown outcome pull before retrying.",
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
      remember(codeAuthoringServices.pull),
      "Read lasting Code with {codeId}, returning the complete editable project and resetting this chat's draft, as code_pull. Editor rights required.",
    ),
    defineAiTool({
      name: "code_write",
      description:
        "Edit the server-held draft with {codeId,path,content}, {codeId,path,delete:true} or {codeId,path,renameTo}. Call init/pull/read first; they reset the draft. Write one file per call; test/**/*.json paths are fixtures. Returns a compact file/byte summary. Check/test/simulate/submit read this same draft. Legacy {project,path,content} replaces the draft and returns the complete replacement project.",
      inputSchema: codeChatAuthoringInputs.write,
      outputSchema: z.union([CodeChatDraftSummarySchema, codeAuthoringContracts.pull.data, CodeAuthoringErrorSchema]),
      approval: "never",
    }).server((input, context) =>
      safe(
        async () => {
          if (Buffer.byteLength(JSON.stringify(input)) > CODE_AUTHORING_REQUEST_BYTES)
            throw new CodeDataError("BAD_INPUT", "Code request exceeds the checker budget.");
          const codeId = input.codeId ?? input.project!.config.codeId;
          await contextFor(context, codeId);
          if (input.project) {
            const project = { ...input.project, files: { ...input.project.files, [input.path]: input.content! } };
            if (Buffer.byteLength(JSON.stringify(project)) > CODE_AUTHORING_REQUEST_BYTES)
              throw new CodeDataError("BAD_INPUT", "Code project exceeds the checker budget.");
            await updateCodeChatDraft(codeId, conversationId(context), () => ({
              entry: project.config.entry,
              files: Object.fromEntries(Object.entries(project.files).filter(([path]) => !isFixture(path))),
              tests: Object.fromEntries(Object.entries(project.files).filter(([path]) => isFixture(path))),
              baseVersionId: project.config.baseVersionId,
            }));
            return codeAuthoringContracts.pull.data.parse(project);
          }
          const draft = await updateCodeChatDraft(codeId, conversationId(context), (current) => {
            const previous = requireCodeChatDraft(current);
            const next: CodeChatDraftParts = { ...previous, files: { ...previous.files }, tests: { ...previous.tests } };
            const bucket = isFixture(input.path) ? "tests" : "files";
            if (input.content !== undefined) next[bucket] = { ...next[bucket], [input.path]: input.content };
            else if (input.delete) delete next[bucket][input.path];
            else if (input.renameTo !== undefined) {
              if (!Object.hasOwn(next[bucket], input.path)) throw new CodeDataError("NOT_FOUND", "Code draft file not found.");
              const destination = isFixture(input.renameTo) ? "tests" : "files";
              next[destination] = { ...next[destination], [input.renameTo]: next[bucket][input.path]! };
              if (input.path !== input.renameTo) delete next[bucket][input.path];
              if (next.entry === input.path) next.entry = input.renameTo;
            }
            return next;
          });
          return codeChatDraftSummary(draft);
        },
        context,
        "write",
      ),
    ),
    tool(
      "check",
      { input: codeChatAuthoringInputs.check, data: codeAuthoringContracts.check.data },
      async (input, context, chat) => {
        const draft = await draftFor(input, chat);
        return codeAuthoringServices.check({ codeId: input.codeId, files: draft.files, entry: draft.entry }, context);
      },
      "Check the server-held draft with {codeId}. Explicit files or entry replace that draft part first. Returns diagnostics, warnings and operation/target permissions at file/line locations. Fix errors before test and submit; address each warning or know why it is fine.",
    ),
  ];
}
