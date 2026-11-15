import { afterEach, expect, test } from "bun:test";
import type { AssistantContentBlock } from "@k2b/nessi/ai";
import { openAICompatible } from "@k2b/nessi/ai";
import { type AiTurnBlock, type AiWireEvent, applyWireEventToBlocks, buildBlocksFromMessages } from "./protocol";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Kimi K3 reasoning stays separate from answer text in live and saved chat blocks", async () => {
  // Excerpt of the stored regression in k2b-dev/nessi#39; transport boundaries are reconstructed.
  const reasoning = "Update test/default.json to mock the browse call, or the GET / test will fail due to missing mock.";
  const answer = "Jetzt aktualisiere ich das Test-Fixture mit den gemockten Notebook-Daten und prüfe alles.";
  const content = `${reasoning}<|close|>think<|sep|>${answer}`;
  const sse = [...content]
    .map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`)
    .join("")
    .concat('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  globalThis.fetch = Object.assign(async () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }), {
    preconnect: () => {},
  });
  const provider = openAICompatible({ name: "fixture", model: "kimi-k3", baseURL: "https://provider.example.test/v1" });
  const saved: AssistantContentBlock[] = [];
  const kinds = new Map<string, "text" | "thinking">();
  let live: AiTurnBlock[] = [];
  let seq = 0;
  for await (const event of provider.stream({ messages: [] })) {
    if (event.type === "issue") throw new Error(event.issue.kind);
    if (event.type === "block_start" && (event.kind === "text" || event.kind === "thinking")) kinds.set(event.blockId, event.kind);
    if (event.type === "block_delta") {
      const blockKind = kinds.get(event.blockId);
      if (!blockKind) throw new Error("Missing block kind");
      const wire: AiWireEvent = {
        v: 1,
        conversationId: "conversation",
        turnId: "turn",
        attempt: 1,
        seq: ++seq,
        type: "block_delta",
        blockId: event.blockId,
        blockKind,
        delta: event.delta,
      };
      live = applyWireEventToBlocks(live, wire);
      const visible = live
        .filter((block) => block.kind === "text")
        .map((block) => block.text)
        .join("");
      expect(answer.startsWith(visible)).toBe(true);
    }
    if (event.type === "block_end") saved.push(event.block);
  }
  const projection = (blocks: AiTurnBlock[]) => blocks.map(({ kind, ...block }) => ({ kind, text: "text" in block ? block.text : "" }));
  const expected: ReturnType<typeof projection> = [
    { kind: "thinking", text: reasoning },
    { kind: "text", text: answer },
  ];
  expect(projection(live)).toEqual(expected);
  expect(projection(buildBlocksFromMessages([{ seq: 1, message: { role: "assistant", content: saved } }]))).toEqual(expected);
});
