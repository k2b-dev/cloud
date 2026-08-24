import { basename } from "node:path";
import {
  AI_IMAGE_INPUT_MAX_BYTES,
  AI_TURN_ATTACHMENT_MAX_ITEMS,
  AI_TURN_IMAGE_MAX_TOTAL_BYTES,
  type AiConversation,
  type AiDraftContentPart,
  type AiFileStat,
  type AiTurnBlock,
  type AiTurnContentPart,
  guessAiMediaType,
  isAiImageMediaType,
} from "@valentinkolb/cloud/ai";
import { type CloudCliContext, printStructured } from "@valentinkolb/cloud/cli";
import { AI_API, jsonRequest, printValue, readApi } from "./shared";
import { type AssistantTurnStreamResult, streamAssistantTurn } from "./stream";

export type ConversationDetail = {
  conversation: AiConversation;
  activeTurn: { turnId: string; status: string } | null;
};

type TurnSubmission = { turn: { id: string; status: string; modelProfileId: string | null } };

export const conversationPath = (conversationId: string, suffix = ""): string =>
  `/conversations/${encodeURIComponent(conversationId)}${suffix}`;

export const readConversationDetail = (ctx: CloudCliContext, conversationId: string): Promise<ConversationDetail> =>
  readApi<ConversationDetail>(ctx, conversationPath(conversationId));

export const validateLocalAttachments = async (paths: readonly string[]): Promise<void> => {
  if (paths.length > AI_TURN_ATTACHMENT_MAX_ITEMS) {
    throw new Error(`At most ${AI_TURN_ATTACHMENT_MAX_ITEMS} attachments can be sent with one message.`);
  }
  let imageBytes = 0;
  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`Attachment not found: ${path}`);
    const mediaType = file.type || guessAiMediaType(path);
    if (!isAiImageMediaType(mediaType)) continue;
    if (file.size > AI_IMAGE_INPUT_MAX_BYTES) {
      throw new Error(`Image attachment exceeds the ${AI_IMAGE_INPUT_MAX_BYTES / (1024 * 1024)} MB limit: ${path}`);
    }
    imageBytes += file.size;
  }
  if (imageBytes > AI_TURN_IMAGE_MAX_TOTAL_BYTES) {
    throw new Error(`Image attachments exceed the ${AI_TURN_IMAGE_MAX_TOTAL_BYTES / (1024 * 1024)} MB total limit.`);
  }
};

export const resolveConversation = async (
  ctx: CloudCliContext,
  input: { conversationId?: string; title?: string; projectId?: string },
): Promise<AiConversation> =>
  input.conversationId
    ? readConversationDetail(ctx, input.conversationId).then((detail) => detail.conversation)
    : readApi<AiConversation>(
        ctx,
        "/conversations",
        jsonRequest("POST", { ...(input.title ? { title: input.title } : {}), ...(input.projectId ? { projectId: input.projectId } : {}) }),
      );

export const uploadAttachment = async (
  ctx: CloudCliContext,
  conversationId: string,
  localPath: string,
): Promise<AiTurnContentPart & { version: number }> => {
  const file = Bun.file(localPath);
  if (!(await file.exists())) throw new Error(`Attachment not found: ${localPath}`);
  const mediaType = file.type || guessAiMediaType(localPath);
  if (isAiImageMediaType(mediaType) && file.size > AI_IMAGE_INPUT_MAX_BYTES) {
    throw new Error(`Image attachment exceeds the ${AI_IMAGE_INPUT_MAX_BYTES / (1024 * 1024)} MB limit: ${localPath}`);
  }
  const form = new FormData();
  form.set("file", new File([await file.arrayBuffer()], basename(localPath), { type: mediaType }));
  const uploaded = await ctx.readJson<{ file: AiFileStat }>(
    await ctx.fetch(`${AI_API}${conversationPath(conversationId, "/files")}`, { method: "POST", body: form }),
  );
  return {
    type: "attachment",
    path: uploaded.file.path,
    mediaType: uploaded.file.mediaType,
    size: uploaded.file.size,
    version: uploaded.file.version,
  };
};

const submitDraftBody = async (ctx: CloudCliContext, conversationId: string, body: unknown): Promise<unknown> => {
  if (!body || typeof body !== "object") return body;
  const input = body as {
    message?: string;
    content?: Array<{ type: string; text?: string; path?: string; mediaType?: string; size?: number; version?: number }>;
    modelProfileId?: string;
    clientToolIds?: string[];
  };
  const detail = await readConversationDetail(ctx, conversationId);
  if (detail.conversation.draft.content.length > 0) {
    throw new Error("This conversation has an unsent composer draft. Send or clear it in Assistant before using the CLI.");
  }
  const content = [
    ...(input.message?.trim() ? [{ type: "text" as const, text: input.message.trim() }] : []),
    ...(input.content ?? []).flatMap((part): AiDraftContentPart[] => {
      if (part.type === "text" && part.text?.trim()) return [{ type: "text" as const, text: part.text.trim() }];
      if (
        part.type === "attachment" &&
        part.path &&
        part.mediaType &&
        typeof part.size === "number" &&
        typeof part.version === "number"
      ) {
        return [{ type: "file" as const, path: part.path, mediaType: part.mediaType, size: part.size, version: part.version }];
      }
      return [];
    }),
  ];
  const draft = await readApi<AiConversation["draft"]>(
    ctx,
    conversationPath(conversationId, "/draft"),
    jsonRequest("PUT", { expectedRevision: detail.conversation.draft.revision, content }),
  );
  return { draftRevision: draft.revision, modelProfileId: input.modelProfileId, clientToolIds: input.clientToolIds };
};

export const submitAssistantTurn = async (input: {
  ctx: CloudCliContext;
  conversationId: string;
  path: string;
  body: unknown;
  watch: boolean;
  approveTools?: readonly string[];
  signal?: AbortSignal;
  onToolBlock?: (block: Extract<AiTurnBlock, { kind: "tool" }>) => void;
}): Promise<{ submitted: TurnSubmission; result?: AssistantTurnStreamResult }> => {
  const streamResponse = input.watch
    ? await input.ctx.fetch(`${AI_API}${conversationPath(input.conversationId, "/stream")}`, {
        headers: { Accept: "text/event-stream" },
        signal: input.signal,
      })
    : undefined;
  if (streamResponse && (!streamResponse.ok || !streamResponse.body)) await input.ctx.readJson(streamResponse);
  let submitted: TurnSubmission;
  try {
    const body = input.path.endsWith("/turns")
      ? await submitDraftBody(input.ctx, input.conversationId, input.body)
      : input.body;
    submitted = await readApi<TurnSubmission>(input.ctx, input.path, jsonRequest("POST", body));
  } catch (error) {
    await streamResponse?.body?.cancel().catch(() => undefined);
    throw error;
  }
  if (!input.watch) return { submitted };
  return {
    submitted,
    result: await streamAssistantTurn({
      ctx: input.ctx,
      conversationId: input.conversationId,
      turnId: submitted.turn.id,
      initialResponse: streamResponse,
      approveTools: input.approveTools,
      signal: input.signal,
      onToolBlock: input.onToolBlock,
    }),
  };
};

export const submitAndMaybeWatch = async (input: {
  ctx: CloudCliContext;
  conversationId: string;
  path: string;
  body: unknown;
  watch: boolean;
  approveTools?: readonly string[];
}): Promise<number> => {
  const { submitted, result } = await submitAssistantTurn(input);
  if (!result) {
    printValue(input.ctx, submitted, submitted.turn.id);
    return 0;
  }
  printStructured(input.ctx, result);
  if (result.status === "failed") throw new Error(result.error || "Assistant turn failed.");
  if (result.status === "needs_attention") {
    if (input.ctx.options.output === "text") {
      input.ctx.error(
        `Turn ${result.turnId} needs attention. Run \`cld assistant actions list ${input.conversationId} ${result.turnId}\`.`,
      );
    }
    return 2;
  }
  return result.status === "aborted" ? 130 : 0;
};
