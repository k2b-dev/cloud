import { CursorMismatchError, RetentionGapError, type TopicEvent } from "@k2b/sync";
import type { LiveEnvelope, LiveTopic } from "./live-engine";

/** Publishes an application's real outbox without starting its application. */
export { startLiveOutbox } from "./live";
export {
  /** Creates the real delivery engine for application channel tests. */
  createLiveEngine,
  /** Platform bounds; restore any intervals shortened by a test. */
  LIVE_LIMITS,
  /** The delivery engine used by channel tests. */
  type LiveEngine,
  /** One application's update, access change, or resync hint. */
  type LiveEnvelope,
  /** The topic operations consumed by the delivery engine. */
  type LiveTopic,
} from "./live-engine";

/** A memory topic with Sync cursor and retention rules, plus publish and trim controls. */
export const createMemoryLiveTopic = () => {
  const name = crypto.randomUUID().replaceAll("-", "");
  let sequence = 0;
  let first = 1;
  const events: TopicEvent<LiveEnvelope>[] = [];
  const wakes = new Set<() => void>();
  const cursorAt = (seq: number) => `s6t.${name}.${seq}`;
  const cursorSequence = (cursor: string) => {
    const match = /^s6t\.([a-z0-9]+)\.(\d+)$/.exec(cursor);
    if (!match || match[1] !== name) throw new CursorMismatchError("The cursor belongs to another topic");
    return Number(match[2]);
  };
  const checkGap = (position: number) => {
    if (position + 1 < first) throw new RetentionGapError(cursorAt(position + 1), cursorAt(first), cursorAt(first - 1));
  };
  return {
    cursorAt,
    cursorSequence,
    head: async () => cursorAt(sequence),
    publish: (data: LiveEnvelope) => {
      events.push({
        data,
        eventId: String(++sequence),
        cursor: cursorAt(sequence),
        sequence,
        tenantId: "default",
        publishedAt: new Date(),
      });
      for (const wake of wakes) wake();
    },
    trim: (count: number) => {
      events.splice(0, Math.max(0, count));
      first = events[0]?.sequence ?? sequence + 1;
    },
    replay: (options: { after?: string; until?: string } = {}): AsyncIterable<TopicEvent<LiveEnvelope>> => {
      const after = cursorSequence(options.after ?? cursorAt(0));
      const until = options.until ? cursorSequence(options.until) : sequence;
      checkGap(after);
      const batch = events.filter((event) => event.sequence > after && event.sequence <= until);
      return (async function* () {
        yield* batch;
      })();
    },
    follow: (options: { after?: string; signal?: AbortSignal } = {}): AsyncIterable<TopicEvent<LiveEnvelope>> => {
      let position = cursorSequence(options.after ?? cursorAt(0));
      return (async function* () {
        while (!options.signal?.aborted) {
          checkGap(position);
          for (const event of events.filter((event) => event.sequence > position)) {
            position = event.sequence;
            yield event;
          }
          // Publication during a yielded batch must not be lost before we wait.
          if (sequence > position) continue;
          await new Promise<void>((resolve) => {
            const wake = () => {
              wakes.delete(wake);
              options.signal?.removeEventListener("abort", wake);
              resolve();
            };
            wakes.add(wake);
            options.signal?.addEventListener("abort", wake, { once: true });
            if (options.signal?.aborted) wake();
          });
        }
      })();
    },
  } satisfies LiveTopic & { publish(data: LiveEnvelope): void; trim(count: number): void };
};
