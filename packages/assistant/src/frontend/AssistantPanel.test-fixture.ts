import type { AiConversation, AiPublicModelProfile, AiStoredMessage } from "@k2b/cloud/ai";

const now = "2026-10-21T12:00:00.000Z";
const models: AiPublicModelProfile[] = [
  { id: "standard", label: "Standard", provider: "ollama", model: "standard", capabilities: ["streaming"], dataBoundary: "private" },
];
const conversation = (id: string): AiConversation => ({
  id,
  shortId: id,
  title: "Project planning",
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: now,
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "fixture-user",
  createdAt: now,
  updatedAt: now,
});

/** Synthetic HTTP data only. The browser renders the real workspace and controller. */
export function assistantPanelFixture() {
  const conversations = new Map<string, AiConversation>();
  const messages = new Map<string, AiStoredMessage[]>();
  const creations = new Map<string, string>();
  const requests: { path: string; body: unknown }[] = [];
  let submitted = 0;
  let lostCreate = false;
  let lostSend = false;
  let rejectSend = false;
  let uploads = 0;
  let uploadGate: Promise<void> | undefined;
  const reset = () => {
    conversations.clear();
    messages.clear();
    creations.clear();
    submitted = 0;
    requests.length = 0;
    lostCreate = false;
    lostSend = false;
    rejectSend = false;
    uploads = 0;
    uploadGate = undefined;
  };
  const detail = (id: string) => ({
    conversation: conversations.get(id)!,
    messages: messages.get(id) ?? [],
    activeTurn: null,
    timeline: [],
    hasMoreMessages: false,
  });
  const snapshot = (url: URL) => {
    const id = url.searchParams.get("conversation");
    return {
      embedded: url.pathname.includes("/panel"),
      userId: "fixture-user",
      cloudUrl: url.origin,
      status: { ok: true, enabled: true, defaultModelId: "standard", visionModelConfigured: false, error: null, models },
      models,
      lastModelId: "standard",
      timeZone: "UTC",
      renderedAt: now,
      initialLiveCursor: "s6t.cloud-live-core.0",
      initialConversations: [...conversations.values()],
      initialQuestions: { items: [], count: 0 },
      initialDoneCount: 0,
      initialConversationId: id,
      initialArtifactPath: null,
      initialDetail: id ? detail(id) : null,
      initialContext: null,
      projects: [],
      initialProject: null,
      initialProjectChats: null,
      initialProjectContext: null,
      approvals: { page: { items: [], nextCursor: null, count: 0, elsewhere: 0 }, open: false },
    };
  };
  const respond = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url),
      path = url.pathname;
    if (request.method === "POST" || request.method === "PUT")
      requests.push({
        path,
        body: await request
          .clone()
          .json()
          .catch(() => null),
      });
    if (path === "/api/assistant/workspace/sidebar")
      return Response.json({ conversations: [...conversations.values()], projects: [], doneCount: 0, questions: { items: [], count: 0 } });
    if (path === "/api/approvals") return Response.json({ items: [], nextCursor: null, count: 0, elsewhere: 0 });
    if (!path.startsWith("/api/ai/")) return null;
    if (path === "/api/ai/conversations" && request.method === "POST") {
      const input = await request.json();
      let id = creations.get(input.requestId);
      if (!id) {
        id = `Chat2${"23456789"[conversations.size]}`;
        conversations.set(id, conversation(id));
        creations.set(input.requestId, id);
      }
      if (lostCreate) {
        lostCreate = false;
        return new Response("Lost creation response", { status: 502 });
      }
      return Response.json(conversations.get(id));
    }
    const match = /^\/api\/ai\/conversations\/([^/]+)(.*)$/.exec(path);
    if (!match) return Response.json([]);
    const id = match[1]!,
      suffix = match[2]!,
      chat = conversations.get(id);
    if (!chat) return Response.json({ message: "Not found" }, { status: 404 });
    if (suffix === "/files" && request.method === "POST") {
      uploads++;
      const data = await request.formData();
      const file = data.get("file");
      if (!(file instanceof File)) return new Response(null, { status: 400 });
      await uploadGate;
      return Response.json({ file: { path: `/uploads/${file.name}`, mediaType: file.type, size: file.size, version: 1 } });
    }
    if (suffix === "/dictations") return Response.json({ items: [], nextCursor: null });
    if (suffix === "/stream") return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    if (suffix === "/draft" && request.method === "PUT") {
      const body = await request.json();
      if (body.expectedRevision !== chat.draft.revision) return Response.json({ message: "Draft conflict" }, { status: 409 });
      chat.draft = { content: body.content, revision: chat.draft.revision + 1, updatedAt: now };
      return Response.json(chat.draft);
    }
    if (suffix === "/turns" && request.method === "POST") {
      const body = await request.json();
      if (rejectSend) {
        rejectSend = false;
        return new Response("Request lost before acceptance", { status: 502 });
      }
      if (body.draftRevision !== chat.draft.revision) return Response.json({ message: "Draft conflict" }, { status: 409 });
      const seq = (messages.get(id)?.length ?? 0) + 1;
      const message: AiStoredMessage = {
        id: `Msg${seq}`,
        shortId: `Msg${seq}`,
        conversationId: id,
        seq,
        kind: "message",
        message: { role: "user", content: chat.draft.content.filter((part) => part.type === "text") },
        loopId: `Turn${seq}`,
        modelProfileId: "standard",
        providerModel: "standard",
        usage: null,
        stopReason: null,
        loopAggregate: null,
        loopDoneReason: null,
        compactedAt: null,
        meta: { submittedDraftRevision: chat.draft.revision },
        createdAt: now,
      };
      const reply: AiStoredMessage = {
        ...message,
        id: `Msg${seq + 1}`,
        shortId: `Msg${seq + 1}`,
        seq: seq + 1,
        meta: null,
        message: { role: "assistant", content: [{ type: "text", text: "The project plan is ready for your review." }] },
      };
      messages.set(id, [...(messages.get(id) ?? []), message, reply]);
      chat.draft = { content: [], revision: chat.draft.revision + 1, updatedAt: now };
      submitted++;
      if (lostSend) {
        lostSend = false;
        return new Response("Lost turn response", { status: 502 });
      }
      return Response.json({ message, turn: { id: message.loopId, modelProfileId: "standard" } });
    }
    if (suffix.startsWith("/submission/")) {
      const revision = Number(suffix.split("/").at(-1));
      const sent = messages.get(id)?.find((message) => message.meta?.submittedDraftRevision === revision);
      return Response.json({ submission: sent ? { messageId: sent.id, turnId: sent.loopId } : null });
    }
    if (!suffix) return Response.json(detail(id));
    return Response.json([]);
  };
  return {
    requests,
    snapshot,
    respond,
    reset,
    conversations,
    submitted: () => submitted,
    loseCreate: () => {
      lostCreate = true;
    },
    loseSend: () => {
      lostSend = true;
    },
    rejectSend: () => {
      rejectSend = true;
    },
    uploads: () => uploads,
    holdUpload: () => {
      let release!: () => void;
      uploadGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}
