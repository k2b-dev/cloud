import { expect, test } from "bun:test";
import { summarizeTurnTiming } from "./turn-timing";

test("resumed generation, browser wait, nested approvals and parallel tools use exclusive wall intervals", () => {
  expect(
    summarizeTurnTiming({
      start: 0,
      end: 60000,
      outputTokens: 600,
      generation: [
        { start: 0, end: 10000 },
        { start: 50000, end: 60000 },
      ],
      tools: [
        { start: 20000, end: 50000 },
        { start: 22000, end: 40000 },
      ],
      waits: [
        { start: 10000, end: 20000 },
        { start: 30000, end: 40000 },
      ],
    }),
  ).toEqual({
    wallMs: 60000,
    totalElapsedMs: 60000,
    generationMs: 20000,
    toolExecutionMs: 20000,
    actionWaitMs: 20000,
    outputTokensPerSecond: 30,
  });
});

test("phase intervals are clipped and zero generation never invents output speed", () => {
  expect(
    summarizeTurnTiming({ start: 10, end: 100, generation: [], tools: [{ start: 0, end: 200 }], waits: [], outputTokens: 1000 }),
  ).toEqual({ wallMs: 90, totalElapsedMs: 90, generationMs: 0, toolExecutionMs: 90, actionWaitMs: 0 });
});
