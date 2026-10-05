import { type LiveServerMessage, LiveServerMessageSchema } from "../events/live-protocol";
import { createLiveWebSocket, type LiveWebSocket } from "./live-websocket";

export type LiveSubscriptionHandlers<T> = {
  /** The cursor the server-rendered state belongs to; `null` starts at the current position. */
  cursor: string | null;
  /** Validates one event's data. A failure reloads the state through `resync`. */
  parse: (data: unknown) => T;
  /** Applies events in order. Idempotent: reconnects and retries can repeat an event. */
  apply: (events: { data: T; cursor: string }[]) => Promise<void>;
  /** Loads the canonical state again; events after it follow. */
  resync: () => Promise<void>;
  /** The subscription ended because its resource is gone or no longer readable. */
  revoked?: (code: "not_found" | "access_denied") => void;
  /** Live updates stopped: the session ended, or `apply` or `resync` kept failing. Never called after `close()`. */
  unavailable: () => void;
};

export type LiveSubscription = { close: () => void };

export type LiveConnection = {
  subscribe: <T>(channel: string, scope: unknown, handlers: LiveSubscriptionHandlers<T>) => LiveSubscription;
};

type Subscriber = {
  frame: () => unknown;
  confirmed: boolean;
  receive: (message: LiveServerMessage) => void;
  end: () => void;
};

type Shared = { socket: LiveWebSocket; subscribers: Map<string, Subscriber>; next: number };

const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
const MAX_BATCH = 100;
/** Events that may wait for `apply`; more collapse into one `resync`, which covers them. */
const MAX_WAITING = 10 * MAX_BATCH;

/** One socket per URL and page, shared by every subscription on it. */
const shared = new Map<string, Shared>();

const parseMessage = (raw: string): LiveServerMessage | null => {
  try {
    const parsed = LiveServerMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const connect = (url: string, activity: "visible" | "always"): Shared => {
  const subscribers = new Map<string, Subscriber>();
  const socket = createLiveWebSocket<LiveServerMessage>({
    url,
    activity,
    parse: parseMessage,
    onOpen: (controls) => {
      for (const subscriber of subscribers.values()) {
        subscriber.confirmed = false;
        controls.send(subscriber.frame());
      }
    },
    onMessage: (message) => {
      if (message.t === "progress") {
        for (const subscriber of subscribers.values()) if (subscriber.confirmed) subscriber.receive(message);
        return;
      }
      if (message.t !== "error") subscribers.get(message.id)?.receive(message);
    },
    onFatal: () => {
      if (shared.get(url)?.socket === socket) shared.delete(url);
      for (const subscriber of [...subscribers.values()]) subscriber.end();
    },
  });
  return { socket, subscribers, next: 0 };
};

type Work<T> = { kind: "events"; events: { data: T; cursor: string }[] } | { kind: "mark" | "resync"; cursor: string };

/**
 * Subscribes to channels of an application's live socket (`/api/<app>/live`).
 * Each subscription applies its events serially and moves its cursor only after
 * `apply` resolved or at a server mark, so a reconnect resumes exactly there.
 * Only `resync` reloads state; a returning tab replays what it missed.
 */
export const liveConnection = (url: string, options: { activity?: "visible" | "always" } = {}): LiveConnection => ({
  subscribe: <T>(channel: string, scope: unknown, handlers: LiveSubscriptionHandlers<T>): LiveSubscription => {
    let connection = shared.get(url);
    if (!connection) {
      connection = connect(url, options.activity ?? "visible");
      shared.set(url, connection);
    }
    const { socket, subscribers } = connection;
    const id = String(++connection.next);
    let cursor = handlers.cursor;
    /** The cursor of a `resync` that has not finished: a reconnect resumes after it. */
    let resyncAt: string | null = null;
    let ended = false;
    let running = false;
    const work: Work<T>[] = [];

    const attempt = async (run: () => Promise<void>): Promise<boolean> => {
      for (let tries = 0; ; tries++) {
        try {
          await run();
          return true;
        } catch {
          const delay = RETRY_DELAYS_MS[tries];
          if (delay === undefined || ended) return false;
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (ended) return false;
        }
      }
    };

    const drain = async () => {
      if (running) return;
      running = true;
      try {
        while (work.length > 0 && !ended) {
          const item = work.shift() as Work<T>;
          if (item.kind === "mark") {
            cursor = item.cursor;
            continue;
          }
          const applied = item.kind === "events" ? await attempt(() => handlers.apply(item.events)) : await attempt(handlers.resync);
          if (!applied) {
            // A closed subscription reports nothing: its owner ended it.
            if (ended) return;
            stop();
            handlers.unavailable();
            return;
          }
          cursor = item.kind === "events" ? (item.events.at(-1)?.cursor ?? cursor) : item.cursor;
          if (item.kind === "resync" && resyncAt === item.cursor) resyncAt = null;
        }
      } finally {
        running = false;
      }
    };

    /** Work queued before a resync is covered by the reloaded state. */
    const resync = (at: string) => {
      work.length = 0;
      work.push({ kind: "resync", cursor: at });
      resyncAt = at;
    };

    const waiting = () => work.reduce((count, item) => count + (item.kind === "events" ? item.events.length : 0), 0);

    const subscriber: Subscriber = {
      frame: () => {
        const after = resyncAt ?? cursor;
        return { t: "sub", id, channel, scope, ...(after ? { after } : {}) };
      },
      confirmed: false,
      receive: (message) => {
        if (ended) return;
        if (message.t === "revoked") {
          stop();
          handlers.revoked?.(message.code);
          return;
        }
        if (message.t === "ready" || message.t === "progress") {
          subscriber.confirmed = true;
          work.push({ kind: "mark", cursor: message.cursor });
        } else if (message.t === "resync") {
          subscriber.confirmed = true;
          resync(message.cursor);
        } else if (message.t === "event") {
          let data: T;
          try {
            data = handlers.parse(message.data);
          } catch {
            resync(message.cursor);
            void drain();
            return;
          }
          const last = work.at(-1);
          if (waiting() >= MAX_WAITING) resync(message.cursor);
          else if (last?.kind === "events" && last.events.length < MAX_BATCH) last.events.push({ data, cursor: message.cursor });
          else work.push({ kind: "events", events: [{ data, cursor: message.cursor }] });
        }
        void drain();
      },
      end: () => {
        if (ended) return;
        stop();
        handlers.unavailable();
      },
    };

    const stop = () => {
      if (ended) return;
      ended = true;
      work.length = 0;
      if (subscribers.get(id) !== subscriber) return;
      subscribers.delete(id);
      socket.send({ t: "unsub", id });
      if (subscribers.size === 0 && shared.get(url) === connection) {
        shared.delete(url);
        socket.dispose();
      }
    };

    subscribers.set(id, subscriber);
    if (subscribers.size === 1) socket.connect();
    else socket.send(subscriber.frame());
    return { close: stop };
  },
});
