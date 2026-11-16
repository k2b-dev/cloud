import { type ToastHandle, type ToastOptions, toast } from "@k2b/ui";
import {
  type AppUnavailableReason,
  GATEWAY_STATUS_PATH,
  MAINTENANCE_ADMIN_API_PATH,
  type MaintenancePollKind,
  maintenancePollDelay,
  parseUnavailableHeader,
  UNAVAILABLE_HEADER,
} from "../contracts/maintenance-signals";
import { type MaintenanceNoticeMessages, maintenanceNoticeMessages } from "./maintenance-notice-messages";

/**
 * An open page while the whole Cloud is in maintenance or one app restarts. The gateway answers this page's requests
 * with a `503` problem (`maintenance` or `app_unavailable`); from the first one on, the page shows one persistent
 * toast that says why, and polls the gateway status until it is over. Nothing on the page is discarded:
 *
 * - reads (`GET`, `HEAD`) wait quietly and are sent again once it is over, so no raw error appears. Reads of the same
 *   method and address wait as one: a polling query adds no request while it waits, and all of them get the one
 *   answer at the end. At most `MAX_WAITING_READS` addresses wait per page; a further one is answered like an action;
 * - every other request is an action with an effect: it is never held or repeated. It returns the gateway's `503`
 *   with a `message` that names the reason, as apps show it for any failed action; the person presses again later.
 *
 * The notice shows one condition at a time. Reads that wait for another one (a second app) are sent again after
 * every status check, so they meet their own condition once the shown one is over. A hidden tab does not poll.
 *
 * A page rendered past the maintenance wall with an admin bypass link says that only this person sees the Cloud,
 * blocks nothing, and offers administrators to end the maintenance.
 */

type Condition =
  | { kind: "cloud" }
  | { kind: "app"; appId: string; reason: AppUnavailableReason; appName?: string }
  | { kind: "bypass"; canEnd: boolean };

export type MaintenanceNoticeOptions = {
  locale: () => string;
  /** The name of an app as the person sees it; else the gateway's name for it, else "this app", never its id. */
  appName?: (appId: string) => string | undefined;
  /** The gateway let this page past the maintenance wall with an admin bypass link. */
  bypass?: boolean;
  /** The viewer may end the maintenance (`POST /api/admin/maintenance/off`). */
  canEnd?: boolean;
  /** Delay before the next status check; the gateway page's schedule unless a test replaces it. */
  delay?: (kind: MaintenancePollKind, elapsedMs: number) => number;
};

const BARRIER = "ti-barrier-block";
/**
 * Distinct addresses that may wait at once per page. No public contract or client constant bounds a page's reads, so
 * this is an operational budget: a Cloud page (shell, rail, one app view) loads a few dozen distinct reads at most, 64
 * doubles that, and it caps the burst each open tab sends the gateway when maintenance ends. The 65th address is not
 * held: it gets its `503` with the reason at once, and the notice stays.
 */
export const MAX_WAITING_READS = 64;
/** A status check that hangs counts as a failed one; the next check follows the schedule. */
const STATUS_TIMEOUT_MS = 10_000;

type FetchInput = Parameters<typeof window.fetch>[0];
type FetchInit = Parameters<typeof window.fetch>[1];
type Problem = { condition: Condition; problem: Record<string, unknown>; headers: Headers };

const methodOf = (input: FetchInput, init: FetchInit): string =>
  (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

const sameOriginUrl = (input: FetchInput): URL | null => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    return url.origin === window.location.origin ? url : null;
  } catch {
    return null;
  }
};

/**
 * The condition a gateway `503` problem describes, from its `X-Cloud-Unavailable` header (also without a body, as for
 * `HEAD`) or else from its body, with the problem fields; null for every other answer, the gateway's page included.
 */
const readProblem = async (response: Response): Promise<Problem | null> => {
  if (response.status !== 503) return null;
  if (!(response.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/problem+json")) return null;
  const body: unknown = response.body
    ? await response
        .clone()
        .json()
        .catch(() => null)
    : null;
  const problem: Record<string, unknown> = body && typeof body === "object" ? { ...body } : {};
  const signal = parseUnavailableHeader(response.headers.get(UNAVAILABLE_HEADER));
  const code = signal?.code ?? problem.code;
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  if (code === "maintenance") return { condition: { kind: "cloud" }, problem: { status: 503, ...problem, code }, headers };
  if (code !== "app_unavailable") return null;
  const appId = signal?.code === "app_unavailable" ? signal.appId : problem.appId;
  if (typeof appId !== "string" || !appId) return null;
  const reason = (signal?.code === "app_unavailable" ? signal.reason : problem.reason) === "updating" ? "updating" : "unavailable";
  const appName = typeof problem.appName === "string" && problem.appName ? { appName: problem.appName } : {};
  return {
    condition: { kind: "app", appId, reason, ...appName },
    problem: { status: 503, ...problem, code, appId, reason },
    headers,
  };
};

/** `maintenance`: off, on for everyone, or on but passed by this browser's bypass link. `app`: absent when not asked. */
const readStatus = (body: unknown): { maintenance: "off" | "on" | "bypass"; app?: boolean } | null => {
  if (!body || typeof body !== "object" || !("maintenance" in body)) return null;
  const state = body.maintenance;
  const maintenance = !state || typeof state !== "object" ? "off" : "bypass" in state && state.bypass === true ? "bypass" : "on";
  const app =
    "app" in body && body.app && typeof body.app === "object" && "available" in body.app ? body.app.available === true : undefined;
  return app === undefined ? { maintenance } : { maintenance, app };
};

const same = (a: Condition, b: Condition): boolean =>
  a.kind === b.kind && (a.kind !== "app" || (b.kind === "app" && a.appId === b.appId && a.reason === b.reason));

/** One read waiting for its condition to end: one request for every caller of the same method and address. */
type Waiting = {
  args: Parameters<typeof window.fetch>;
  condition: Condition;
  /** The `503` this read met last, as the app would have seen it without the notice. */
  met: Problem;
  callers: Set<{ resolve: (response: Response) => void; reject: (reason: unknown) => void }>;
  sending?: AbortController;
};

export const installMaintenanceNotice = (options: MaintenanceNoticeOptions): (() => void) => {
  const original = window.fetch;
  const delay = options.delay ?? ((kind, elapsedMs) => maintenancePollDelay(kind, elapsedMs, Math.random()));
  const t = (): MaintenanceNoticeMessages => maintenanceNoticeMessages.resolve([options.locale()]).t;
  const name = (condition: Condition & { kind: "app" }): { name?: string } => {
    const known = options.appName?.(condition.appId) || condition.appName;
    return known ? { name: known } : {};
  };
  let current: Condition | null = null;
  let since = 0;
  /** Counts the ends of conditions: a `503` for a request sent before the last end is old news. */
  let ends = 0;
  let notice: ToastHandle | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let ending = false;
  let active = true;
  /** Waiting reads by method and address. */
  const waiting = new Map<string, Waiting>();

  const blockedMessage = (condition: Condition): string => {
    const text = t();
    if (condition.kind !== "app") return text.maintenanceBlocked;
    return condition.reason === "updating" ? text.appUpdatingBlocked(name(condition)) : text.appDownBlocked(name(condition));
  };

  /** The `503` an action gets: the gateway's problem with a `message` in the person's language. */
  const blocked = (met: Problem): Response =>
    new Response(JSON.stringify({ ...met.problem, message: blockedMessage(met.condition) }), { status: 503, headers: met.headers });

  const view = (condition: Condition): { description: string; options: ToastOptions } => {
    const text = t();
    const still = { duration: 0, action: null, progress: null } satisfies ToastOptions;
    if (condition.kind === "cloud")
      return { description: text.maintenanceKeeps, options: { ...still, variant: "warning", iconClass: BARRIER, title: text.maintenance } };
    if (condition.kind === "bypass")
      return {
        description: text.bypass,
        options: {
          ...still,
          variant: "warning",
          iconClass: BARRIER,
          title: text.maintenance,
          action: condition.canEnd ? { label: text.end, onClick: () => void endMaintenance() } : null,
        },
      };
    const app = name(condition);
    const restarting = { ...still, variant: "default", progress: "indeterminate" } satisfies ToastOptions;
    return condition.reason === "updating"
      ? { description: text.appUpdatingKeeps, options: { ...restarting, title: text.appUpdating(app) } }
      : { description: text.appDownKeeps(app), options: { ...restarting, title: text.appDown(app) } };
  };

  /** Changes the toast in place. A toast the person closed stays closed for this condition; a new one shows again. */
  const present = (description: string, toastOptions: ToastOptions, fresh: boolean) => {
    if (notice?.update(description, toastOptions)) return;
    notice = fresh ? toast(description, toastOptions) : undefined;
  };

  /** A hidden tab does not poll; becoming visible checks at once. */
  const schedule = () => {
    clearTimeout(timer);
    if (!current || !active || document.visibilityState === "hidden") return;
    timer = setTimeout(() => void check(), delay(current.kind === "app" ? "app" : "cloud", Date.now() - since));
  };

  /** Hands one answer to every caller of a waiting read. */
  const deliver = (key: string, entry: Waiting, response: Response) => {
    waiting.delete(key);
    const [first, ...rest] = [...entry.callers];
    const copies = rest.map((caller) => ({ caller, response: response.clone() }));
    first?.resolve(response);
    for (const copy of copies) copy.caller.resolve(copy.response);
  };

  /** Sends one waiting read again. Another `503` keeps it waiting for that condition. */
  const resend = async (key: string, entry: Waiting): Promise<void> => {
    const controller = new AbortController();
    entry.sending = controller;
    const sentAfter = ends;
    const [input, init] = entry.args;
    let response: Response;
    try {
      response = await original.call(window, input, { ...init, signal: controller.signal });
    } catch (error) {
      if (waiting.get(key) === entry) waiting.delete(key);
      for (const caller of entry.callers) caller.reject(error);
      return;
    } finally {
      entry.sending = undefined;
    }
    if (waiting.get(key) !== entry) return void response.body?.cancel().catch(() => undefined);
    const found = active ? await readProblem(response) : null;
    if (!found) return deliver(key, entry, response);
    void response.body?.cancel().catch(() => undefined);
    // Sent before the last end: it is over now, so send it once more.
    if (sentAfter !== ends && !(current && same(current, found.condition))) return resend(key, entry);
    entry.condition = found.condition;
    entry.met = found;
    begin(found.condition);
  };

  /** Sends again every waiting read that does not wait for the condition shown now. */
  const release = () => {
    for (const [key, entry] of waiting) if (!entry.sending && !(current && same(current, entry.condition))) void resend(key, entry);
  };

  const enter = (condition: Condition) => {
    current = condition;
    since = Date.now();
    const next = view(condition);
    present(next.description, next.options, true);
    if (condition.kind === "bypass") release();
    schedule();
  };

  const finish = (condition: Condition) => {
    current = null;
    ends += 1;
    clearTimeout(timer);
    const text = t();
    const title =
      condition.kind === "app"
        ? condition.reason === "updating"
          ? text.appUpdated
          : text.appBack(name(condition))
        : text.maintenanceEnded;
    const description = condition.kind === "bypass" ? text.bypassEnded : text.continue;
    // Omitted duration: the success toast closes after its reading time.
    const ended: ToastOptions = { variant: "success", title, duration: undefined, progress: null, action: null };
    if (!notice?.update(description, ended)) toast.success(description, { title });
    notice = undefined;
    release();
  };

  /** A request met a `503` problem. Whole-Cloud maintenance covers every app; one app is shown at a time. */
  const begin = (condition: Condition) => {
    if (current && (same(current, condition) || (current.kind === "cloud" && condition.kind === "app"))) return;
    if (current?.kind === "app" && condition.kind === "app") return;
    enter(condition);
  };

  /** Applies a status answer to the condition it was asked for. */
  const settle = (watched: Condition, status: NonNullable<ReturnType<typeof readStatus>>) => {
    const bypass: Condition = { kind: "bypass", canEnd: options.canEnd === true };
    if (status.maintenance === "on") return watched.kind === "cloud" ? schedule() : enter({ kind: "cloud" });
    // An app restarting under a bypassed maintenance ends with the app; the bypass notice then comes back.
    if (watched.kind === "app") {
      if (status.app !== true) return schedule();
      finish(watched);
      if (status.maintenance === "bypass") enter(bypass);
      return;
    }
    if (status.maintenance === "bypass") return watched.kind === "bypass" ? schedule() : enter(bypass);
    finish(watched);
  };

  const check = async () => {
    clearTimeout(timer);
    const watched = current;
    if (!watched || checking || !active || document.visibilityState === "hidden") return;
    checking = true;
    let status: ReturnType<typeof readStatus> = null;
    const controller = new AbortController();
    const hang = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    try {
      const url = watched.kind === "app" ? `${GATEWAY_STATUS_PATH}?app=${encodeURIComponent(watched.appId)}` : GATEWAY_STATUS_PATH;
      const response = await original.call(window, url, { cache: "no-store", signal: controller.signal });
      if (response.ok) status = readStatus(await response.json());
    } catch {
      // No answer, such as while the gateway itself restarts: keep the notice and ask again on schedule.
    } finally {
      clearTimeout(hang);
      checking = false;
    }
    if (!active) return;
    if (current !== watched || !status) schedule();
    else settle(watched, status);
    // Reads that wait for another condition repeat at most once per check, so they meet their own.
    release();
  };

  const endMaintenance = async () => {
    if (ending || current?.kind !== "bypass") return;
    ending = true;
    const text = t();
    present(text.ending, { title: text.maintenance, progress: "indeterminate", action: null }, false);
    let ended = false;
    try {
      const response = await original.call(window, `${MAINTENANCE_ADMIN_API_PATH}/off`, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      ended = response.ok;
    } catch {
      ended = false;
    } finally {
      ending = false;
    }
    if (current?.kind !== "bypass") return;
    if (ended) return finish(current);
    const again = view(current);
    present(text.endFailed, again.options, true);
  };

  /**
   * Joins the waiting read of this method and address, which ends with one answer for all its callers; rejects with
   * the caller's own abort reason. Null when `MAX_WAITING_READS` other addresses wait already.
   */
  const wait = (key: string, args: Parameters<typeof window.fetch>, met: Problem | null): Promise<Response> | null => {
    let entry = waiting.get(key);
    if (!entry) {
      if (!met || waiting.size >= MAX_WAITING_READS) return null;
      entry = { args, condition: met.condition, met, callers: new Set() };
      waiting.set(key, entry);
    }
    const joined = entry;
    const [input, init] = args;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const caller = {
        resolve: (response: Response) => {
          signal?.removeEventListener("abort", abort);
          resolve(response);
        },
        reject: (reason: unknown) => {
          signal?.removeEventListener("abort", abort);
          reject(reason);
        },
      };
      const abort = () => {
        joined.callers.delete(caller);
        reject(signal?.reason);
        if (joined.callers.size > 0) return;
        if (waiting.get(key) === joined) waiting.delete(key);
        joined.sending?.abort();
      };
      joined.callers.add(caller);
      signal?.addEventListener("abort", abort, { once: true });
    });
  };

  const wrapped: typeof window.fetch = Object.assign(async (...args: Parameters<typeof window.fetch>): Promise<Response> => {
    const [input, init] = args;
    const url = sameOriginUrl(input);
    if (!url || url.pathname === GATEWAY_STATUS_PATH || !active) return original.apply(window, args);
    const method = methodOf(input, init);
    const read = method === "GET" || method === "HEAD";
    const key = `${method} ${url.href}`;
    // A read whose address already waits sends nothing: it gets the answer the waiting one gets.
    if (read && waiting.has(key)) return wait(key, args, null) ?? original.apply(window, args);
    for (let late = 0; ; late++) {
      const sentAfter = ends;
      const response = await original.apply(window, args);
      const found = active ? await readProblem(response) : null;
      if (!found) return response;
      // Sent before the last end: old news, never a second notice. A read goes once more, an action keeps its answer.
      const old = sentAfter !== ends && !(current && same(current, found.condition));
      void response.body?.cancel().catch(() => undefined);
      if (old && read && late === 0) continue;
      if (!old) begin(found.condition);
      if (!read || old) return blocked(found);
      return wait(key, args, found) ?? blocked(found);
    }
  }, original);
  window.fetch = wrapped;

  const now = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", now);
  window.addEventListener("online", now);
  if (options.bypass) enter({ kind: "bypass", canEnd: options.canEnd === true });

  return () => {
    active = false;
    current = null;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", now);
    window.removeEventListener("online", now);
    if (window.fetch === wrapped) window.fetch = original;
    notice?.dismiss();
    // Never send anything again from here: every waiting read gets the `503` it met, as without the notice. A read
    // on its way gets its own answer.
    for (const [key, entry] of waiting) {
      if (entry.sending) continue;
      waiting.delete(key);
      const body = methodOf(...entry.args) === "HEAD" ? null : JSON.stringify(entry.met.problem);
      for (const caller of entry.callers) caller.resolve(new Response(body, { status: 503, headers: entry.met.headers }));
    }
  };
};
