import { NDJSON_CONTENT_TYPE, readNdjsonLines } from "../browser/ndjson";
import type { WidgetAnswer, WidgetLoadRequest } from "../browser/widgets";
import { type CapabilityCaller, callerRequest } from "../capabilities/server-invoke";
import type { WidgetStreamLine } from "../contracts/widgets";

export type { WidgetAnswer, WidgetLoadRequest } from "../browser/widgets";

/**
 * What the server render has: the entries that answered within the budget, by entry id, and the entries still owed,
 * which the page asks for again after hydration with `streamWidgets({ requests: pending })`.
 */
export type WidgetsWithin = { answered: Record<string, WidgetAnswer>; pending: WidgetLoadRequest[] };

/**
 * Asks Core for dashboard widgets while a page renders on the server, with the person's own credentials, the way the
 * browser does (`POST /api/widgets/v1` through Core's trusted server transport): Core signs every widget's invocation
 * and asks them in parallel, each within its own deadline. The render keeps what answers within `budgetMs`, counted
 * from this call, and then stops reading; stopping the stream ends every widget Core still waits for. A request Core
 * refuses, a broken stream or an exhausted budget leaves the entries pending, and the page asks for them in the
 * browser, where each frame settles on its own.
 *
 * The caller is the person: their `cookie` or `authorization` (an app, a mandate, a workload or an in-process authority
 * is refused). `budgetMs` has no default: it is the page's decision, derived from measured widget times.
 */
export const loadWidgetsWithin = async (
  caller: CapabilityCaller,
  requests: readonly WidgetLoadRequest[],
  options: { budgetMs: number },
): Promise<WidgetsWithin> => {
  if (caller.app || caller.mandate || caller.workload || caller.authority || !(caller.cookie || caller.authorization))
    throw new Error("Use exactly one person authority source");
  if (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0) throw new RangeError("budgetMs must be a positive number");
  const answered: Record<string, WidgetAnswer> = {};
  const owed = () => requests.filter((entry) => answered[entry.id] === undefined);
  if (requests.length === 0) return { answered, pending: [] };
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), options.budgetMs);
  try {
    const base = await callerRequest(caller, "/api/widgets/v1", undefined, budget.signal);
    const headers = new Headers(base.headers);
    headers.set("accept", NDJSON_CONTENT_TYPE);
    headers.set("content-type", "application/json");
    const response = await (caller.transport ?? fetch)(new Request(base, { headers, body: JSON.stringify({ widgets: requests }) }));
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return { answered, pending: owed() };
    }
    // The budget cancels the body itself, so the read ends and Core sees the stream close even where the transport does
    // not follow the request's signal (an in-process Core).
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: budget.signal });
    const ids = new Set(requests.map((entry) => entry.id));
    await readNdjsonLines<WidgetStreamLine>(
      new Response(body),
      (line) => {
        if (line.type === "widget" && line.id !== undefined && ids.has(line.id)) answered[line.id] = line;
      },
      "Widgets",
    );
  } catch {
    // Pending entries load in the browser; the budget, a refused request or a broken stream all end up here.
  } finally {
    clearTimeout(timer);
  }
  return { answered, pending: owed() };
};
