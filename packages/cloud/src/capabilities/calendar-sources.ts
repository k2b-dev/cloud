import { z } from "zod";
import {
  CALENDAR_SOURCE_MAX_RANGE_MS,
  CALENDAR_SOURCE_PAGE_LIMIT,
  CalendarEventsDataSchema,
  CalendarListDataSchema,
  calendarSourceIssues,
  projectCalendarDescriptor,
  projectCalendarItem,
} from "../contracts/calendar-source";
import {
  type CalendarReadResult,
  type CalendarSelection,
  type CalendarSourceListEntry,
  type CalendarSourceSummary,
  CalendarViewRangeSchema,
} from "../contracts/calendar-view";
import { CapabilityAppIdSchema } from "../contracts/capabilities";
import { type CapabilityCaller, invokeCapabilityWithDataSchema, listCapabilityCatalog } from "./server-invoke";
import type { CapabilityCatalogApp, CapabilityClientError } from "./types";

export * from "../contracts/calendar-view";

// Interactive read budget: 60 requests, six in flight, 4 MiB of pages.
const MAX_CALLS = 60;
const MAX_BYTES = 4 * 1024 * 1024;
const CONCURRENCY = 6;
const SelectionSchema = z
  .array(z.object({ appId: CapabilityAppIdSchema, calendarId: z.string().min(1).max(2048) }).strict())
  .max(CALENDAR_SOURCE_PAGE_LIMIT);

class ReadStopped extends Error {
  constructor(
    readonly state: "pending" | "truncated" | "failed",
    readonly code: string,
    readonly retryable = true,
  ) {
    super(code);
  }
}
const failure = (error: CapabilityClientError) =>
  new ReadStopped("failed", error.code, error.status === 429 || error.status >= 500 || error.status === 499);

/** One request only; no identity, catalog or source data survives this session. */
class ReadSession {
  private calls = 0;
  private bytes = 0;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly upstream: AbortSignal[];
  private stop: ReadStopped | undefined;
  readonly credentials: CapabilityCaller;
  constructor(credentials: CapabilityCaller, deadline: number, signal?: AbortSignal) {
    if (!Number.isFinite(deadline)) throw new RangeError("Calendar deadline must be a finite epoch time in milliseconds");
    this.credentials = { ...credentials, signal: this.controller.signal };
    if (!credentials.authority) {
      this.credentials.transport = async (request) => {
        const response = await (credentials.transport ?? fetch)(request);
        if (!response.body) return response;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform: (chunk, controller) => {
              this.addBytes(chunk.byteLength);
              controller.enqueue(chunk);
            },
          }),
          { signal: this.controller.signal },
        );
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      };
    }
    this.upstream = [...new Set([credentials.signal, signal].filter((value): value is AbortSignal => value !== undefined))];
    for (const upstream of this.upstream) upstream.addEventListener("abort", this.abort, { once: true });
    this.timer = setTimeout(() => this.halt(new ReadStopped("pending", "CALENDAR_DEADLINE")), Math.max(0, deadline - Date.now()));
    if (this.upstream.some((upstream) => upstream.aborted)) this.abort();
    else if (deadline <= Date.now()) this.halt(new ReadStopped("pending", "CALENDAR_DEADLINE"));
  }
  private readonly abort = () => this.halt(new ReadStopped("pending", "REQUEST_CANCELLED"));
  private halt(reason: ReadStopped) {
    this.stop ??= reason;
    this.controller.abort();
  }
  check() {
    if (this.stop) throw this.stop;
  }
  private addBytes(bytes: number) {
    this.bytes += bytes;
    if (this.bytes > MAX_BYTES) {
      this.halt(new ReadStopped("truncated", "CALENDAR_BYTE_BUDGET"));
      this.check();
    }
  }
  async page<T>(read: () => Promise<T>): Promise<T> {
    this.check();
    if (this.calls >= MAX_CALLS) {
      this.halt(new ReadStopped("truncated", "CALENDAR_CALL_BUDGET"));
      this.check();
    }
    this.calls++;
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(this.stop ?? new ReadStopped("pending", "REQUEST_CANCELLED"));
        this.controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = await Promise.race([read(), cancelled]);
      this.check();
      // Core in-process authority has no transport body; count its serialized page instead.
      if (this.credentials.authority) this.addBytes(new TextEncoder().encode(JSON.stringify(result)).byteLength);
      return result;
    } finally {
      if (onAbort) this.controller.signal.removeEventListener("abort", onAbort);
    }
  }
  close() {
    clearTimeout(this.timer);
    for (const upstream of this.upstream) upstream.removeEventListener("abort", this.abort);
  }
}

const catalog = async (session: ReadSession): Promise<CapabilityCatalogApp[]> => {
  const apps: CapabilityCatalogApp[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await session.page(() => listCapabilityCatalog({ caller: session.credentials, cursor, limit: 25 }));
    if (!page.ok) throw failure(page.error);
    apps.push(...page.data.apps);
    cursor = page.data.page.hasMore ? page.data.page.nextCursor : undefined;
    if (cursor && seen.has(cursor)) throw new ReadStopped("failed", "CALENDAR_CURSOR_LOOP", false);
    if (cursor) seen.add(cursor);
    if (page.data.page.hasMore && !cursor) throw new ReadStopped("failed", "INVALID_APP_RESPONSE", false);
  } while (cursor);
  return apps.filter((app) => app.manifest.calendarSource && calendarSourceIssues(app.manifest).length === 0);
};
const workers = async <T>(values: T[], run: (value: T) => Promise<void>) => {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
      while (index < values.length) await run(values[index++]!);
    }),
  );
};
const stopped = (error: unknown) => (error instanceof ReadStopped ? error : new ReadStopped("failed", "APP_UNAVAILABLE"));

/** Follow calendar pagination for the current caller. A partial list is explicitly failed. */
export const listCalendarSources = async (
  credentials: CapabilityCaller,
  options: { deadline: number; signal?: AbortSignal },
): Promise<CalendarSourceListEntry[]> => {
  const session = new ReadSession(credentials, options.deadline, options.signal);
  try {
    const apps = await catalog(session);
    const result = apps.map(
      (app): CalendarSourceListEntry => ({
        appId: app.appId,
        name: app.appName,
        icon: app.appIcon ?? null,
        state: "ok",
        error: null,
        calendars: [],
      }),
    );
    await workers(apps, async (app) => {
      const source = result.find((source) => source.appId === app.appId)!;
      try {
        let cursor: string | undefined;
        const seen = new Set<string>();
        const ids = new Set<string>();
        do {
          const page = await session.page(() =>
            invokeCapabilityWithDataSchema(
              {
                appId: app.appId,
                capabilityId: app.manifest.calendarSource!.calendars,
                kind: "query",
                input: { limit: CALENDAR_SOURCE_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
              },
              CalendarListDataSchema,
              session.credentials,
            ),
          );
          if (!page.ok) throw failure(page.error);
          for (const entry of page.data.data.items)
            if (!ids.has(entry.id)) {
              ids.add(entry.id);
              if (source.calendars.length < CALENDAR_SOURCE_PAGE_LIMIT) source.calendars.push(projectCalendarDescriptor(entry));
            }
          cursor = page.data.data.next ?? undefined;
          if (ids.size > CALENDAR_SOURCE_PAGE_LIMIT) throw new ReadStopped("truncated", "CALENDAR_CALENDAR_BUDGET");
          if (cursor && seen.has(cursor)) throw new ReadStopped("failed", "CALENDAR_CURSOR_LOOP", false);
          if (cursor) seen.add(cursor);
        } while (cursor);
      } catch (error) {
        const reason = stopped(error);
        source.state = "failed";
        source.error = { code: reason.code, retryable: reason.retryable };
      }
    });
    return result;
  } finally {
    session.close();
  }
};

/** Deadline is an absolute epoch millisecond time. onSource receives each source's final progress state. */
export const readCalendarEvents = async (options: {
  credentials: CapabilityCaller;
  calendars: CalendarSelection[];
  from: string;
  to: string;
  signal?: AbortSignal;
  deadline: number;
  onSource?: (source: CalendarSourceSummary) => void;
}): Promise<CalendarReadResult> => {
  const calendars = SelectionSchema.parse(options.calendars);
  const { from, to } = CalendarViewRangeSchema.parse({ from: options.from, to: options.to });
  const grouped = new Map<string, Set<string>>();
  for (const { appId, calendarId } of calendars) {
    const ids = grouped.get(appId) ?? new Set<string>();
    ids.add(calendarId);
    grouped.set(appId, ids);
  }
  const result: CalendarReadResult = { items: [], sources: [...grouped.keys()].map((appId) => ({ appId, state: "pending", error: null })) };
  if (!calendars.length) return result;
  const session = new ReadSession(options.credentials, options.deadline, options.signal);
  const dedupe = new Set<string>();
  try {
    let apps: CapabilityCatalogApp[];
    try {
      apps = await catalog(session);
    } catch (error) {
      const reason = stopped(error);
      for (const source of result.sources) {
        source.state = reason.state;
        source.error = { code: reason.code, retryable: reason.retryable };
        options.onSource?.({ ...source });
      }
      return result;
    }
    await workers(result.sources, async (source) => {
      try {
        session.check();
        const app = apps.find((app) => app.appId === source.appId);
        if (!app) throw new ReadStopped("failed", "CAPABILITY_NOT_FOUND", false);
        for (let start = Date.parse(from); start < Date.parse(to); start += CALENDAR_SOURCE_MAX_RANGE_MS) {
          const end = Math.min(start + CALENDAR_SOURCE_MAX_RANGE_MS, Date.parse(to));
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const page = await session.page(() =>
              invokeCapabilityWithDataSchema(
                {
                  appId: source.appId,
                  capabilityId: app.manifest.calendarSource!.events,
                  kind: "query",
                  input: {
                    calendarIds: [...grouped.get(source.appId)!],
                    from: new Date(start).toISOString(),
                    to: new Date(end).toISOString(),
                    limit: CALENDAR_SOURCE_PAGE_LIMIT,
                    ...(cursor ? { cursor } : {}),
                  },
                },
                CalendarEventsDataSchema,
                session.credentials,
              ),
            );
            if (!page.ok) throw failure(page.error);
            for (const item of page.data.data.items) {
              if (!grouped.get(source.appId)!.has(item.calendarId)) continue;
              const key = JSON.stringify([source.appId, item.calendarId, item.id]);
              if (dedupe.has(key)) continue;
              dedupe.add(key);
              result.items.push({ ...projectCalendarItem(item), appId: source.appId });
            }
            cursor = page.data.data.next ?? undefined;
            if (cursor && seen.has(cursor)) throw new ReadStopped("failed", "CALENDAR_CURSOR_LOOP", false);
            if (cursor) seen.add(cursor);
          } while (cursor);
        }
        source.state = "ok";
      } catch (error) {
        const reason = stopped(error);
        source.state = reason.state;
        source.error = { code: reason.code, retryable: reason.retryable };
      }
      options.onSource?.({ ...source });
    });
    const point = (item: CalendarReadResult["items"][number]) => {
      const time = item.type === "deadline" ? (item.due.kind === "date" ? item.due.date : item.due.at) : item.time.start;
      return Date.parse(time);
    };
    result.items.sort(
      (a, b) =>
        point(a) - point(b) || a.appId.localeCompare(b.appId) || a.calendarId.localeCompare(b.calendarId) || a.id.localeCompare(b.id),
    );
    return result;
  } finally {
    session.close();
  }
};
