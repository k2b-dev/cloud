import type { LoopAggregate, OutboundEvent } from "@k2b/nessi";
import { sql } from "bun";

export type TimingInterval = { start: number; end: number };
const union = (intervals: TimingInterval[]): TimingInterval[] => {
  const result: TimingInterval[] = [];
  for (const interval of intervals.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    const previous = result.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
};
const duration = (intervals: TimingInterval[]) => union(intervals).reduce((sum, x) => sum + x.end - x.start, 0);
const excluding = (intervals: TimingInterval[], removed: TimingInterval[]) => {
  let result = union(intervals);
  for (const cut of union(removed))
    result = result.flatMap((x) =>
      cut.end <= x.start || cut.start >= x.end
        ? [x]
        : [
            { start: x.start, end: Math.min(x.end, cut.start) },
            { start: Math.max(x.start, cut.end), end: x.end },
          ].filter((x) => x.end > x.start),
    );
  return result;
};

/** Exclusive phase durations; parallel tools and nested approvals never double-count wall time. */
export function summarizeTurnTiming(input: {
  start: number;
  end: number;
  generation: TimingInterval[];
  tools: TimingInterval[];
  waits: TimingInterval[];
  outputTokens?: number;
}): NonNullable<LoopAggregate["timing"]> {
  const clip = (rows: TimingInterval[]) => rows.map((x) => ({ start: Math.max(input.start, x.start), end: Math.min(input.end, x.end) }));
  const generation = clip(input.generation),
    waits = excluding(clip(input.waits), generation);
  const generationMs = duration(generation),
    actionWaitMs = duration(waits);
  const toolExecutionMs = duration(excluding(clip(input.tools), [...generation, ...waits]));
  const wallMs = Math.max(0, input.end - input.start);
  return {
    wallMs,
    totalElapsedMs: wallMs,
    generationMs,
    actionWaitMs,
    toolExecutionMs,
    ...(generationMs > 0 && input.outputTokens !== undefined ? { outputTokensPerSecond: input.outputTokens / (generationMs / 1000) } : {}),
  };
}

/** One recorder per executor attempt; rows survive client actions and process resumption. */
export function createTurnTimingRecorder(turnId: string, db = sql) {
  let requestId: string | null = null;
  const finishGeneration = async () => {
    if (!requestId) return;
    const id = requestId;
    requestId = null;
    await db`UPDATE ai.turn_generation_timings SET ended_at=now() WHERE turn_id=${turnId}::uuid AND request_id=${id} AND ended_at IS NULL`;
  };
  return {
    finishGeneration,
    async event(event: OutboundEvent) {
      if (event.type === "turn_start" && !event.resumed) {
        await finishGeneration();
        requestId = event.turnId;
        await db`INSERT INTO ai.turn_generation_timings(turn_id,request_id) VALUES(${turnId}::uuid,${requestId}) ON CONFLICT DO NOTHING`;
      } else if (
        event.type === "usage" ||
        event.type === "tool_execution_start" ||
        event.type === "turn_end" ||
        event.type === "loop_end"
      ) {
        await finishGeneration();
      }
    },
  };
}

export async function withDurableTurnTiming(turnId: string, aggregate: LoopAggregate, db = sql): Promise<LoopAggregate> {
  const [turn] = await db<
    { start: Date; end: Date }[]
  >`SELECT created_at AS start,COALESCE(completed_at,now()) AS end FROM ai.turns WHERE id=${turnId}::uuid`;
  const generation = await db<
    { start: Date; end: Date | null }[]
  >`SELECT started_at AS start,ended_at AS end FROM ai.turn_generation_timings WHERE turn_id=${turnId}::uuid`;
  // An older/incomplete trace cannot justify a speed computed from the whole loop's tokens.
  if (!turn || generation.length < aggregate.assistantMessageCount || generation.some((x) => !x.end)) {
    const { timing: _, ...rest } = aggregate;
    return rest;
  }
  const tools = await db<
    { start: Date; end: Date }[]
  >`SELECT started_at AS start,COALESCE(completed_at,now()) AS end FROM ai.tool_calls WHERE turn_id=${turnId}::uuid AND started_at IS NOT NULL`;
  const waits = await db<{ start: Date; end: Date }[]>`SELECT a.created_at AS start,
    CASE WHEN a.kind='client_tool' THEN LEAST(COALESCE(t.started_at,a.resolved_at,now()),COALESCE(a.resolved_at,now())) ELSE COALESCE(a.resolved_at,now()) END AS end
    FROM ai.pending_actions a LEFT JOIN ai.tool_calls t ON t.turn_id=a.turn_id AND t.call_id=a.call_id WHERE a.turn_id=${turnId}::uuid`;
  const intervals = (rows: { start: Date; end: Date | null }[]) =>
    rows.flatMap((x) => (x.end ? [{ start: new Date(x.start).getTime(), end: new Date(x.end).getTime() }] : []));
  return {
    ...aggregate,
    timing: summarizeTurnTiming({
      start: new Date(turn.start).getTime(),
      end: new Date(turn.end).getTime(),
      generation: intervals(generation),
      tools: intervals(tools),
      waits: intervals(waits),
      outputTokens: aggregate.usage?.output,
    }),
  };
}
