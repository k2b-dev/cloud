import { NDJSON_CONTENT_TYPE } from "../browser/ndjson";
import { type CapabilityCaller, callerRequest } from "../capabilities/server-invoke";
import type { DashboardWidgetSize, WidgetSettings, WidgetStreamLine } from "../contracts/widgets";

/** One dashboard entry to ask for, as the browser's `streamWidgets({ requests })` sends it. */
export type WidgetLoadRequest = { id: string; key: string; size?: DashboardWidgetSize; settings?: WidgetSettings };

/** The answer of one widget, exactly the line Core's widget stream sends for it. */
export type WidgetAnswer = Extract<WidgetStreamLine, { type: "widget" }>;

/**
 * What the server render has: the entries that answered within the budget, by entry id, and the entries still owed,
 * which the page asks for again after hydration with `streamWidgets({ requests: pending })`.
 */
export type WidgetsWithin = { answered: Record<string, WidgetAnswer>; pending: WidgetLoadRequest[] };

/**
 * Asks Core for dashboard widgets while a page renders on the server, with the person's own credentials, the way the
 * browser does (`POST /api/widgets/v1` through Core's trusted server transport): Core signs every widget's invocation
 * and asks them in parallel, each within its own deadline. The render keeps what answers within `budgetMs`, counted
 * from this call, and then stops reading; stopping the stream ends every widget Core still waits for. Nothing fails
 * here: a request Core refuses, a broken stream or an exhausted budget leaves the entries pending, and the page asks
 * for them in the browser, where each frame settles on its own.
 *
 * `budgetMs` has no default: it is the page's decision, derived from measured widget times.
 */
export const loadWidgetsWithin = async (
  caller: CapabilityCaller,
  requests: readonly WidgetLoadRequest[],
  options: { budgetMs: number },
): Promise<WidgetsWithin> => {
  const answered: Record<string, WidgetAnswer> = {};
  const owed = () => requests.filter((entry) => answered[entry.id] === undefined);
  if (requests.length === 0) return { answered, pending: [] };
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), options.budgetMs);
  let reader: ReadableStreamDefaultReader<string> | undefined;
  try {
    const base = await callerRequest(caller, "/api/widgets/v1", undefined, budget.signal);
    const headers = new Headers(base.headers);
    headers.set("accept", NDJSON_CONTENT_TYPE);
    headers.set("content-type", "application/json");
    const request = new Request(base, { headers, body: JSON.stringify({ widgets: requests }) });
    const response = await (caller.transport ?? fetch)(request);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return { answered, pending: owed() };
    }
    reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const ids = new Set(requests.map((entry) => entry.id));
    // the budget ends the read even where the transport does not see the signal (an in-process Core)
    budget.signal.addEventListener("abort", () => void reader?.cancel().catch(() => undefined), { once: true });
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const text = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!text) continue;
        const line: WidgetStreamLine = JSON.parse(text);
        if (line.type === "widget" && line.id !== undefined && ids.has(line.id)) answered[line.id] = line;
        if (line.type === "done") return { answered, pending: owed() };
      }
    }
  } catch {
    // Pending entries load in the browser; the budget, a refused request or a broken stream all end up here.
  } finally {
    clearTimeout(timer);
    if (budget.signal.aborted || owed().length > 0) await reader?.cancel().catch(() => undefined);
  }
  return { answered, pending: owed() };
};
