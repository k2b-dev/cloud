import { type CapabilityCaller, listCalendarSources, readCalendarEvents } from "@k2b/cloud/capabilities/server";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import type { Context } from "hono";
import type { CalendarSelection } from "../calendar-contracts";

const credentials = <E extends AuthContext>(c: Context<E>): CapabilityCaller => ({
  cookie: c.req.header("Cookie"),
  authorization: c.req.header("Authorization"),
  requestId: c.req.header("X-Request-Id") ?? null,
  traceparent: c.req.header("traceparent"),
  tracestate: c.req.header("tracestate"),
  signal: c.req.raw.signal,
  locale: getLocale(c),
});
/** SSR has a 2.5 s interaction budget; browser routes pass their 10 s budget. */
export const loadCalendarSources = <E extends AuthContext>(c: Context<E>, options: { deadlineMs?: number } = {}) =>
  listCalendarSources(credentials(c), { deadline: Date.now() + (options.deadlineMs ?? 2500) });
export const loadCalendarEvents = <E extends AuthContext>(
  c: Context<E>,
  input: { from: string; to: string; calendars: CalendarSelection[]; deadlineMs: number },
) =>
  readCalendarEvents({
    credentials: credentials(c),
    calendars: input.calendars,
    from: input.from,
    to: input.to,
    signal: c.req.raw.signal,
    deadline: Date.now() + input.deadlineMs,
  });
