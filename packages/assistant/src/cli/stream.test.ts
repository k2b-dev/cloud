import { describe, expect, test } from "bun:test";
import type { AiConversation, AiStoredMessage, AiStreamSseEvent, AiTurnBlock } from "@k2b/cloud/ai";
import type { CloudCliContext, CloudCliOutputMode } from "@k2b/cloud/cli";
import { type AssistantTurnOutput, createAssistantTurnOutput, streamAssistantTurn } from "./stream";

const conversation: AiConversation = {
  id: "chat",
  shortId: "chat",
  title: "Chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "",
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user",
  createdAt: "",
  updatedAt: "",
};
const stored = (seq: number, message: AiStoredMessage["message"]): AiStoredMessage => ({
  id: `m${seq}`,
  shortId: `m${seq}`,
  conversationId: "chat",
  seq,
  kind: "message",
  loopId: "turn",
  message,
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: "",
});
const messages = (...parts: string[]) => parts.map((text, i) => stored(i + 1, { role: "assistant", content: [{ type: "text", text }] }));
let seq = 0;
const wire = () => ({ v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1, seq: ++seq });
const delta = (blockId: string, text: string): AiStreamSseEvent => ({
  ...wire(),
  type: "block_delta",
  blockId,
  blockKind: "text",
  delta: text,
});
const state = (blocks: AiTurnBlock[]): AiStreamSseEvent => ({
  type: "state",
  conversation,
  messages: [],
  activeTurn: { turnId: "turn", attempt: 1, seq, status: "running", blocks, modelProfileId: null, createdAt: "" },
});
const finished = (text: string[]): AiStreamSseEvent => ({
  ...wire(),
  type: "turn_finished",
  status: "completed",
  error: null,
  messages: messages(...text),
});
const response = (events: AiStreamSseEvent[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

const textDeltas = (lines: unknown[]) =>
  lines.flatMap((line) =>
    typeof line === "object" &&
    line !== null &&
    "type" in line &&
    line.type === "text_delta" &&
    "blockId" in line &&
    typeof line.blockId === "string" &&
    "delta" in line &&
    typeof line.delta === "string"
      ? [`${line.blockId}:${line.delta}`]
      : [],
  );

const run = async (
  connections: AiStreamSseEvent[][],
  output: CloudCliOutputMode = "text",
  approveTools?: string[],
  turnOutput?: AssistantTurnOutput,
) => {
  const chunks: string[] = [],
    errors: string[] = [],
    lines: unknown[] = [],
    requests: unknown[] = [];
  const ctx: CloudCliContext = {
    args: [],
    flags: {},
    options: { profile: "test", server: "http://example.test", token: "test", output },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async (path, init) => {
      if (init?.method === "POST") {
        requests.push({ path, body: JSON.parse(String(init.body)) });
        return Response.json({});
      }
      const events = connections.shift();
      if (!events) throw new Error("Unexpected connection");
      return response(events);
    },
    readJson: (response) => response.json(),
    print: () => {},
    write: async (value) => {
      chunks.push(value);
    },
    error: (value) => {
      errors.push(value);
    },
    json: () => {},
    jsonLine: (value) => {
      lines.push(value);
    },
    table: () => {},
  };
  const result = await streamAssistantTurn({
    ctx,
    conversationId: "chat",
    turnId: "turn",
    approveTools,
    output: turnOutput,
    signal: AbortSignal.timeout(4000),
  });
  return { text: chunks.join(""), chunks, errors, lines, requests, result };
};

describe("Assistant CLI stream", () => {
  test("interactive resumes share printed text and tool statuses for the turn", async () => {
    const output = createAssistantTurnOutput();
    const query: Extract<AiTurnBlock, { kind: "tool" }> = {
      id: "live-query",
      kind: "tool",
      callId: "query",
      name: "spaces.task.list",
      status: "completed",
    };
    const tool: Extract<AiTurnBlock, { kind: "tool" }> = {
      id: "live-call",
      kind: "tool",
      callId: "call",
      name: "spaces.task.create",
      status: "awaiting_approval",
    };
    const first = await run(
      [
        [
          delta("intro", "Ich lege die Aufgabe an."),
          { ...wire(), type: "block_set", block: query },
          { ...wire(), type: "block_set", block: tool },
        ],
      ],
      "text",
      undefined,
      output,
    );
    expect(first.result.status).toBe("needs_attention");
    const completed = { ...tool, id: "saved-call", status: "completed" as const };
    const second = await run(
      [
        [
          state([{ id: "m1:0", kind: "text", text: "Ich lege die Aufgabe an." }, { ...query, id: "saved-query" }, completed]),
          { ...wire(), type: "block_set", block: completed },
          delta("answer", "Fertig."),
          finished(["Ich lege die Aufgabe an.", "Fertig."]),
        ],
      ],
      "text",
      undefined,
      output,
    );
    expect(second.result.status).toBe("completed");
    expect(first.text + second.text).toBe("Ich lege die Aufgabe an.\n\nFertig.\n");
    expect([...first.errors, ...second.errors]).toEqual([
      "spaces.task.list: completed",
      "spaces.task.create: awaiting approval",
      "spaces.task.create: completed",
    ]);
  });
  test("prints a final answer that is a prefix of an earlier live block", async () => {
    const reply = await run([
      [delta("a", "Fertig. Ich prüfe noch X."), delta("b", "Fertig."), finished(["Fertig. Ich prüfe noch X.", "Fertig."])],
    ]);
    expect(reply.text).toBe("Fertig. Ich prüfe noch X.\n\nFertig.\n");
  });
  test.each([
    ["Ich prüfe das.", "Ich prüfe das."],
    ["Ich schaue nach.", "Ich schaue nach. Gefunden."],
  ])("keeps separate live blocks %s and %s", async (first, second) => {
    const events = () => [[delta("a", first), delta("b", second), finished([first, second])]];
    expect((await run(events())).text).toBe(`${first}\n\n${second}\n`);
    expect(textDeltas((await run(events(), "jsonl")).lines)).toEqual([`a:${first}`, `b:${second}`]);
  });
  test("ignores preserved leading whitespace in a converged block_set", async () => {
    const reply = await run([
      [
        delta("a", "Hello world."),
        { ...wire(), type: "block_set", block: { id: "a", kind: "text", text: "\nHello world." } },
        finished(["\nHello world."]),
      ],
    ]);
    expect(reply.text).toBe("Hello world.\n");
  });
  test("does not repeat adjacent live blocks merged in stored messages", async () => {
    const reply = await run([[delta("a", "A."), delta("b", "B."), finished(["A.B."])]]);
    expect(reply.text).toBe("A.\n\nB.\n");
  });
  test("keeps the first JSONL block ID after a renamed baseline", async () => {
    const events = () => [
      [delta("live", "Found")],
      [state([{ id: "saved", kind: "text", text: "Found" }]), delta("saved", " it."), finished(["Found it."])],
    ];
    expect((await run(events())).text).toBe("Found it.\n");
    expect(textDeltas((await run(events(), "jsonl")).lines)).toEqual(["live:Found", "live: it."]);
  });
  test("prints an identical new live block after a renamed baseline", async () => {
    const events = () => [
      [delta("a1", "Done."), state([{ id: "m1:0", kind: "text", text: "Done." }]), delta("a2", "Done."), finished(["Done.", "Done."])],
    ];
    expect((await run(events())).text).toBe("Done.\n\nDone.\n");
    expect(textDeltas((await run(events(), "jsonl")).lines)).toEqual(["a1:Done.", "a2:Done."]);
  });
  test("emits JSONL turn_finished when the turn completed during a reconnect", async () => {
    const reply = await run(
      [[delta("live", "Checking.")], [{ type: "state", conversation, messages: messages("Checking.", "Done."), activeTurn: null }]],
      "jsonl",
    );
    expect(reply.text).toBe("");
    expect(textDeltas(reply.lines)).toEqual(["live:Checking."]);
    expect(reply.lines.at(-1)).toEqual({
      v: 1,
      conversationId: "chat",
      turnId: "turn",
      type: "turn_finished",
      status: "completed",
      error: null,
      text: "Checking.\n\nDone.",
      messages: messages("Checking.", "Done."),
    });
  });
  test("separates non-blank text blocks and completes only the missing final suffix", async () => {
    const reply = await run([
      [
        delta("intro", "Checking."),
        delta("blank", " \n"),
        delta("answer", "## Ans"),
        delta("answer", "wer"),
        finished(["Checking.", " \n", "## Answer done"]),
      ],
    ]);
    expect(reply.text).toBe("Checking.\n\n## Answer done\n");
    expect(reply.result.text).toBe("Checking.\n\n## Answer done");
    expect(reply.chunks).toEqual(["Checking.", "\n\n## Ans", "wer", " done", "\n"]);
  });
  test.each(["text", "json", "jsonl"] as const)("ignores renamed replayed blocks and emits only new text in %s", async (output) => {
    const reply = await run(
      [
        [delta("live-intro", "Checking."), delta("live-answer", "Found")],
        [
          state([
            { id: "m1:0", kind: "text", text: "Checking." },
            { id: "m2:0", kind: "text", text: "Found" },
          ]),
        ],
        [
          state([
            { id: "m1:0", kind: "text", text: "Checking." },
            { id: "m2:0", kind: "text", text: "Found it." },
            { id: "m3:0", kind: "text", text: "Done" },
          ]),
          delta("m3:0", "."),
          finished(["Checking.", "Found it.", "Done.", "Final."]),
        ],
      ],
      output,
    );
    expect(reply.result.text).toBe("Checking.\n\nFound it.\n\nDone.\n\nFinal.");
    expect(reply.text).toBe(output === "text" ? `${reply.result.text}\n` : "");
    if (output === "jsonl")
      expect(
        reply.lines
          .filter(
            (line): line is { type: string; delta: string } =>
              typeof line === "object" && line !== null && "type" in line && line.type === "text_delta",
          )
          .map((line) => line.delta),
      ).toEqual(["Checking.", "Found", " it.", "Done", "."]);
  });
  test("attempt baselines with renamed IDs preserve the printed prefix", async () => {
    const reply = await run([
      [
        delta("live", "Checking."),
        {
          ...wire(),
          type: "turn_started",
          modelProfileId: "model",
          providerModel: "fixture",
          blocks: [{ id: "saved", kind: "text", text: "Checking." }],
        },
        delta("answer", "Done."),
        finished(["Checking.", "Done."]),
      ],
    ]);
    expect(reply.text).toBe("Checking.\n\nDone.\n");
  });
  test("a completion snapshot emits only the unprinted suffix", async () => {
    const reply = await run([
      [delta("live", "Checking.")],
      [{ type: "state", conversation, messages: messages("Checking.", "Done."), activeTurn: null }],
    ]);
    expect(reply.text).toBe("Checking.\n\nDone.\n");
  });
  test("keeps whitespace until a block has content, without separators for blank blocks", async () => {
    const reply = await run([[delta("blank", "\n"), delta("text", " "), delta("text", "Answer"), finished(["\n", " Answer", " "])]]);
    expect(reply.text).toBe(" Answer\n");
  });
  test("a stale reconnect baseline catches up without repeating earlier output", async () => {
    const reply = await run([
      [delta("live", "Checking. Done")],
      [state([{ id: "saved", kind: "text", text: "Checking." }]), delta("saved", " Done."), finished(["Checking. Done."])],
    ]);
    expect(reply.text).toBe("Checking. Done.\n");
  });
  test.each(["text", "jsonl"] as const)("keeps new text after compaction drops earlier blocks in %s", async (output) => {
    const reply = await run(
      [
        [delta("intro", "Checking."), delta("answer", "Found it.")],
        [
          state([{ id: "saved-answer", kind: "text", text: "Found it." }]),
          delta("new", "Next"),
          delta("new", " step."),
          finished(["Found it.", "Next step.", "Final."]),
        ],
      ],
      output,
    );
    expect(reply.text).toBe(output === "text" ? "Checking.\n\nFound it.\n\nNext step.\n\nFinal.\n" : "");
    if (output === "jsonl")
      expect(reply.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text_delta", blockId: "new", delta: "Next" }),
          expect.objectContaining({ type: "text_delta", blockId: "new", delta: " step." }),
        ]),
      );
  });
  test("a compacted attempt baseline extends the last printed block and keeps the final answer", async () => {
    const reply = await run([
      [
        delta("intro", "Checking."),
        delta("answer", "Found"),
        {
          ...wire(),
          type: "turn_started",
          modelProfileId: "model",
          providerModel: "fixture",
          blocks: [{ id: "saved-answer", kind: "text", text: "Found it." }],
        },
        finished(["Found it.", "Done."]),
      ],
    ]);
    expect(reply.text).toBe("Checking.\n\nFound it.\n\nDone.\n");
  });
  test("completion after compaction does not repeat fully streamed text", async () => {
    const reply = await run([
      [delta("intro", "Checking."), delta("answer", "Found it.")],
      [state([]), delta("final", "Done."), finished(["Found it.", "Done."])],
    ]);
    expect(reply.text).toBe("Checking.\n\nFound it.\n\nDone.\n");
  });
  test("shows canonical tool names and deduplicates replayed statuses by call ID", async () => {
    const tool: Extract<AiTurnBlock, { kind: "tool" }> = {
      id: "live-call",
      kind: "tool",
      callId: "call",
      name: "spaces.task.create",
      status: "running",
    };
    const rebuilt: AiTurnBlock[] = [{ ...tool, id: "persisted-call" }];
    const reply = await run([
      [{ ...wire(), type: "block_set", block: tool }],
      [state(rebuilt), { ...wire(), type: "block_set", block: { ...tool, id: "persisted-call", status: "completed" } }, finished([])],
    ]);
    expect(reply.errors).toEqual(["spaces.task.create: running", "spaces.task.create: completed"]);
  });
  test("matches canonical approval names on a rebuilt call", async () => {
    const blocks: AiTurnBlock[] = [{ id: "persisted-call", kind: "tool", callId: "call", name: "spaces.task.create", status: "running" }];
    const reply = await run(
      [[state(blocks.map((block) => (block.kind === "tool" ? { ...block, status: "awaiting_approval" } : block))), finished([])]],
      "text",
      ["spaces.task.create"],
    );
    expect(reply.result.status).toBe("completed");
    expect(reply.requests).toEqual([
      { path: "/api/ai/conversations/chat/turns/turn/actions/call", body: { type: "approval_response", approved: true } },
    ]);
  });
});
