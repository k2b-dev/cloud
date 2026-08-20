import type { Tool, ToolContext } from "@k2b/nessi";
import { defineTool as defineNessiTool } from "@k2b/nessi";
import type { z } from "zod";
import type { RequestActor } from "../server";
import { aiToolNeedsApproval } from "./approvals";
import type {
  AiDataBoundary,
  AiFrontendToolMode,
  AiProjectFileToolSource,
  AiResolvedModel,
  AiRuntimeTool,
  AiSkillFileToolSource,
  AiToolApprovalPolicy,
  AiToolDefinition,
  AiToolRuntime,
} from "./types";

export const defineAiTool = <TInput extends z.ZodType, TOutput extends z.ZodType>(config: {
  name: string;
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  approval?: AiToolApprovalPolicy;
  /** Per-tool execution timeout. nessi aborts the call and reports a timeout issue. */
  timeoutMs?: number;
  /** One-line "when to use" hint listed in the system prompt's Tool guidance section. */
  promptHint?: string;
  /** Optional compact representation sent to providers in later loops. */
  toHistoricalResult?: (context: { input: z.infer<TInput>; output: z.infer<TOutput>; callId: string }) => unknown | Promise<unknown>;
}) => {
  const def: AiToolDefinition<TInput, TOutput> = {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    approval: config.approval ?? "once",
    timeoutMs: config.timeoutMs,
    promptHint: config.promptHint,
    toHistoricalResult: config.toHistoricalResult,
  };

  return {
    def,
    server(
      run: (
        input: z.infer<TInput>,
        ctx: ToolContext & {
          actor: RequestActor;
          conversationId?: string;
          turnId?: string;
          attachedFilePaths?: ReadonlySet<string>;
          allowedDataBoundaries?: AiDataBoundary[];
          projectFiles?: AiProjectFileToolSource;
          skillFiles?: AiSkillFileToolSource;
          selectedModel?: AiResolvedModel;
        },
      ) => Promise<z.infer<TOutput>>,
    ): AiToolRuntime<TInput, TOutput> {
      return { location: "server", def, run };
    },
    client(): AiToolRuntime<TInput, TOutput> {
      return { location: "client", def };
    },
    clientView(): AiToolRuntime<TInput, TOutput> {
      return { location: "client_view", def };
    },
    clientInteraction(): AiToolRuntime<TInput, TOutput> {
      return { location: "client_interaction", def };
    },
  };
};

export const isFrontendToolMode = (mode: string): mode is AiFrontendToolMode =>
  mode === "client" || mode === "client_view" || mode === "client_interaction";

const isCloudAiTool = (tool: AiRuntimeTool): tool is AiToolRuntime => "location" in tool && "def" in tool;

/** Collect the prompt hints of the tools actually available this turn (tools without a hint are skipped). */
export const aiToolPromptHints = (tools: AiRuntimeTool[]): { name: string; hint: string }[] =>
  tools.flatMap((tool) => (isCloudAiTool(tool) && tool.def.promptHint ? [{ name: tool.def.name, hint: tool.def.promptHint }] : []));

export type PreparedAiTools = {
  tools: Tool[];
  approvalPolicies: Map<string, AiToolApprovalPolicy>;
  frontendModes: Map<string, AiFrontendToolMode>;
};

export type AiToolPreparationContext = {
  actor?: RequestActor;
  conversationId?: string;
  turnId?: string;
  attachedFilePaths?: ReadonlySet<string>;
  allowedDataBoundaries?: AiDataBoundary[];
  projectFiles?: AiProjectFileToolSource;
  skillFiles?: AiSkillFileToolSource;
  selectedModel?: AiResolvedModel;
};

export const prepareAiTools = (input: AiToolPreparationContext & { tools?: AiRuntimeTool[] }): PreparedAiTools => {
  const approvalPolicies = new Map<string, AiToolApprovalPolicy>();
  const frontendModes = new Map<string, AiFrontendToolMode>();

  const tools = (input.tools ?? []).map((tool): Tool => {
    if (!isCloudAiTool(tool)) return tool;

    approvalPolicies.set(tool.def.name, tool.def.approval);

    const nessiTool = defineNessiTool({
      name: tool.def.name,
      description: tool.def.description,
      inputSchema: tool.def.inputSchema,
      outputSchema: tool.def.outputSchema,
      needsApproval: tool.location === "server" && aiToolNeedsApproval(tool.def.approval),
      timeoutMs: tool.def.timeoutMs,
      toHistoricalResult: tool.def.toHistoricalResult,
    });

    if (tool.location === "server") {
      return nessiTool.server((toolInput, ctx) => {
        if (!input.actor) throw new Error(`AI server tool "${tool.def.name}" requires a request actor.`);
        return tool.run(toolInput, {
          ...ctx,
          actor: input.actor,
          conversationId: input.conversationId,
          turnId: input.turnId,
          attachedFilePaths: input.attachedFilePaths,
          allowedDataBoundaries: input.allowedDataBoundaries,
          projectFiles: input.projectFiles,
          skillFiles: input.skillFiles,
          selectedModel: input.selectedModel,
        });
      });
    }

    frontendModes.set(tool.def.name, tool.location);
    return nessiTool.client(async () => {
      throw new Error(`Frontend AI tool "${tool.def.name}" must be executed by the browser.`);
    });
  });

  return { tools, approvalPolicies, frontendModes };
};
