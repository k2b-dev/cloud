import { afterAll, beforeAll, expect, test } from "bun:test";
import type { OutboundEvent, ProviderEvent } from "@k2b/nessi";
import { __aiExecutorTest } from "./executor";
import type { AiCallDetails, AiCallStatus } from "./inference-calls";
import { createAiProvider } from "./provider";
import { inferenceProvider } from "./quota-provider";
import type { AiModelProfile } from "./types";

/**
 * Synthetic replay of a hosted OpenAI-compatible stream that carries reasoning
 * as `delta.reasoning_content` (TensorX, Cortecs). Proves that the generic
 * profile surfaces thinking blocks on the Assistant path and that the call
 * timing marks are recorded without the reasoning text.
 */
const REASONING = "Reasoning that must never appear in a log or record.";
const frames = [
  { choices: [{ delta: { role: "assistant" } }] },
  { choices: [{ delta: { reasoning_content: REASONING.slice(0, 20) } }] },
  { choices: [{ delta: { reasoning_content: REASONING.slice(20) } }] },
  { choices: [{ delta: { content: "Visible answer." } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
];

let server: ReturnType<typeof Bun.serve>;
const logs: string[] = [];
const write = process.stdout.write.bind(process.stdout);

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            for (const frame of frames) {
              await Bun.sleep(5);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  process.stdout.write = ((chunk: string | Uint8Array) => {
    logs.push(String(chunk));
    return write(chunk);
  }) as typeof process.stdout.write;
});

afterAll(() => {
  process.stdout.write = write;
  server.stop(true);
});

const profile: AiModelProfile = {
  id: "hosted-glm",
  label: "Hosted GLM",
  provider: "openai-compatible",
  model: "glm-5-flash",
  enabled: true,
  capabilities: ["streaming"],
  dataBoundary: "hosted",
  baseURL: `http://localhost:${0}/v1`,
};

test("reasoning_content frames reach the Assistant stream as thinking blocks with redacted call timings", async () => {
  const booked: { status: AiCallStatus; details?: AiCallDetails }[] = [];
  const provider = inferenceProvider(
    createAiProvider({ ...profile, baseURL: `http://localhost:${server.port}/v1` }, "secret-key"),
    profile,
    { kind: "chat", task: "chat" },
    undefined,
    {
      begin: async () => ({ id: crypto.randomUUID(), maxOutputTokens: undefined }),
      finish: async (_id, _usage, status, details) => {
        booked.push({ status, details });
      },
      heartbeat: async () => {},
    },
  );
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({ messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] })) events.push(event);

  const thinking = events.filter((event) => event.type === "block_start" && event.kind === "thinking");
  expect(thinking).toHaveLength(1);
  const thinkingEnd = events.find((event) => event.type === "block_end" && event.block.type === "thinking");
  expect(thinkingEnd && thinkingEnd.type === "block_end" && thinkingEnd.block.type === "thinking" ? thinkingEnd.block.thinking : "").toBe(
    REASONING,
  );
  expect(events.some((event) => event.type === "block_start" && event.kind === "text")).toBeTrue();

  // The executor's wire mapping keeps thinking as its own visible block kind.
  const mapper = __aiExecutorTest.createEventMapper(1, []);
  const turn = { agentId: "cloud", loopId: "t", turnId: "t:turn:0", turnIndex: 0 };
  const ops = events.flatMap((event) => mapper.translate({ ...turn, ...event } as OutboundEvent));
  expect(ops.some((op) => op.type === "block_set" && op.block.kind === "thinking")).toBeTrue();
  expect(ops.some((op) => op.type === "block_delta" && op.blockKind === "thinking")).toBeTrue();

  expect(booked).toHaveLength(1);
  const { status, details } = booked[0]!;
  expect(status).toBe("ok");
  expect(details).toMatchObject({ cancelled: false, error: null });
  expect(details?.headersMs).toBeGreaterThanOrEqual(0);
  expect(details?.firstByteMs).toBeGreaterThanOrEqual(details!.headersMs!);
  expect(details?.firstBlockMs).toBeGreaterThanOrEqual(details!.firstByteMs!);
  const recorded = JSON.stringify(details) + logs.join("");
  expect(recorded).not.toContain(REASONING.slice(0, 20));
  expect(recorded).not.toContain("secret-key");
});
