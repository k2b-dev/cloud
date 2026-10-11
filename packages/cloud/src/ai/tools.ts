import type { Tool, ToolContext } from "@k2b/nessi";
import { defineTool as defineNessiTool } from "@k2b/nessi";
import type { z } from "zod";
import type { RequestActor } from "../server";
import { aiToolNeedsApproval } from "./approvals";
import type {
  AiApprovalTarget,
  AiDataBoundary,
  AiFrontendToolMode,
  AiProjectFileToolSource,
  AiResolvedModel,
  AiRuntimeTool,
  AiSkillFileToolSource,
  AiToolApprovalPolicy,
  AiToolDefinition,
  AiToolRuntime,
  AiWebsiteReceipt,
} from "./types";

export const defineAiTool = <TInput extends z.ZodType, TOutput extends z.ZodType>(config: {
  name: string;
  /** Stable identity when `name` is only a provider-safe transport encoding. */
  canonicalName?: string;
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
    canonicalName: config.canonicalName,
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
          locale?: string;
          timeZone?: string;
          /** Localized short status; never include payloads or secrets. */
          reportProgress?: (message: string) => Promise<void>;
          /** Asks like `requestApproval`, and lets the person remember the approval of `target`. */
          requestApprovalFor?: (message: string, target: AiApprovalTarget) => Promise<boolean>;
          /** Relays a decision for an effect another platform component consumes and executes. */
          requestRelayedApproval?: (message: string, options: { approvalId?: string; target?: AiApprovalTarget }) => Promise<boolean>;
          /** Shows requests a website approval let through as they go out, so the chat keeps them whatever the outcome. */
          reportWebsiteReceipts?: (receipts: AiWebsiteReceipt[]) => Promise<void>;
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
  /** Provider tool name to stable tool identity. */
  canonicalNames: Map<string, string>;
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
  locale?: string;
  timeZone?: string;
  reportToolProgress?: (callId: string, message: string) => Promise<void>;
  /** Uses the approved snapshot immediately before the tool executes its effect. */
  consumeApproval?: (approvalCallId: string, input: unknown) => Promise<AiApprovalUse>;
  /** Links a relayed decision to the record the effect owner will consume. */
  linkApproval?: (approvalCallId: string, approvalId: string) => void;
  /** Hears what a nested approval asks for before the approval is requested. */
  describeApproval?: (approvalCallId: string, target: AiApprovalTarget) => void;
  reportWebsiteReceipts?: (callId: string, receipts: AiWebsiteReceipt[]) => Promise<void>;
};

/**
 * What using an approval found: `approved` lets the effect run, `changed` means the approved snapshot no longer
 * matches and asks again, and `used` means an earlier run of the call already used it, so the call must not run again.
 */
export type AiApprovalUse = "approved" | "changed" | "used";

const approvalCallIdPattern = /^(.*)-approval-(\d+)$/;

/**
 * Whether `askedCallIds` holds a question of the same tool call that Nessi asked after `approvalCallId`, the call's
 * own approval or one of its numbered questions. A turn that continues after such a question runs the tool from its
 * start again, so the approvals before it are used again by the same call.
 */
export const aiApprovalAskedLater = (approvalCallId: string, askedCallIds: Iterable<string>): boolean => {
  const own = approvalCallIdPattern.exec(approvalCallId);
  const callId = own ? own[1] : approvalCallId,
    index = own ? Number(own[2]) : -1;
  for (const asked of askedCallIds) {
    const later = approvalCallIdPattern.exec(asked);
    if (later && later[1] === callId && Number(later[2]) > index) return true;
  }
  return false;
};

const approvalUsedError = () =>
  new Error("This approval was already used, so Cloud does not run the call again. Check its outcome before you call again.");

export const prepareAiTools = (input: AiToolPreparationContext & { tools?: AiRuntimeTool[] }): PreparedAiTools => {
  const canonicalNames = new Map<string, string>();
  const approvalPolicies = new Map<string, AiToolApprovalPolicy>();
  const frontendModes = new Map<string, AiFrontendToolMode>();

  const approvalContext = async (toolInput: unknown, ctx: ToolContext, needsApproval: boolean) => {
    const callId = ctx.callId;
    const use = (approvalCallId: string): Promise<AiApprovalUse> =>
      input.consumeApproval ? input.consumeApproval(approvalCallId, toolInput) : Promise.resolve("approved");
    if (needsApproval && input.consumeApproval) {
      const used = callId ? await use(callId) : "changed";
      if (used === "used") throw approvalUsedError();
      if (used === "changed") throw new Error("This approval no longer matches the call. Ask again.");
    }
    // Nessi numbers the approvals of one execution in request order; count them to name each one's call ID.
    let approvals = 0;
    const requestApproval = async (message: string, target?: AiApprovalTarget): Promise<boolean> => {
      while (true) {
        const approvalCallId = `${callId}-approval-${approvals++}`;
        if (target) input.describeApproval?.(approvalCallId, target);
        if (!(await ctx.requestApproval(message))) return false;
        const used = await use(approvalCallId);
        if (used === "approved") return true;
        if (used === "used") throw approvalUsedError();
        // A changed snapshot requires a new human decision under the next Nessi action ID.
      }
    };
    return {
      ...ctx,
      requestApproval,
      requestApprovalFor: (message: string, target: AiApprovalTarget) => requestApproval(message, target),
      requestRelayedApproval: async (message: string, options: { approvalId?: string; target?: AiApprovalTarget }) => {
        const approvalCallId = `${callId}-approval-${approvals++}`;
        if (options.approvalId) input.linkApproval?.(approvalCallId, options.approvalId);
        if (options.target) input.describeApproval?.(approvalCallId, options.target);
        if (!(await ctx.requestApproval(message))) return false;
        // The effect's own record is used where it runs. Without one, as for a website request from code, the relay
        // that hands over the decision uses the chat's record; a decision it cannot use is not handed over as approval.
        return options.approvalId !== undefined || (await use(approvalCallId)) === "approved";
      },
    };
  };

  const tools = (input.tools ?? []).map((tool): Tool => {
    if (!isCloudAiTool(tool)) {
      if (tool.kind !== "server") return tool;
      return {
        ...tool,
        execute: async (toolInput, ctx) => tool.execute(toolInput, await approvalContext(toolInput, ctx, tool.def.needsApproval === true)),
      };
    }

    canonicalNames.set(tool.def.name, tool.def.canonicalName ?? tool.def.name);
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
      return nessiTool.server(async (toolInput, ctx) => {
        if (!input.actor) throw new Error(`AI server tool "${tool.def.name}" requires a request actor.`);
        const report = input.reportToolProgress;
        const callId = ctx.callId;
        return tool.run(toolInput, {
          ...(await approvalContext(toolInput, ctx, aiToolNeedsApproval(tool.def.approval))),
          actor: input.actor,
          conversationId: input.conversationId,
          turnId: input.turnId,
          attachedFilePaths: input.attachedFilePaths,
          allowedDataBoundaries: input.allowedDataBoundaries,
          projectFiles: input.projectFiles,
          skillFiles: input.skillFiles,
          selectedModel: input.selectedModel,
          locale: input.locale,
          timeZone: input.timeZone,
          reportProgress: callId && report ? (message) => report(callId, message) : undefined,
          reportWebsiteReceipts:
            callId && input.reportWebsiteReceipts ? (receipts) => input.reportWebsiteReceipts!(callId, receipts) : undefined,
        });
      });
    }

    frontendModes.set(tool.def.name, tool.location);
    return nessiTool.client(async () => {
      throw new Error(`Frontend AI tool "${tool.def.name}" must be executed by the browser.`);
    });
  });

  return { tools, canonicalNames, approvalPolicies, frontendModes };
};
