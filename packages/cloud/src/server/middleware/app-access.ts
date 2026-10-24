import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { TrieRouter } from "hono/router/trie-router";
import type { WSEvents } from "hono/ws";
import { getApp } from "../../_internal/registry";
import type { AppMeta } from "../../contracts/app";
import { appAccessAuthority, canUseApp } from "../../services/app-access";
import { recordAppAccessDenied } from "../../services/app-access-metrics";
import { createLoginRedirectUrl } from "../../shared/redirect";
import { type AuthContext, auth, type RequestAuthority } from "./auth";

type AccessApp = Pick<AppMeta, "id" | "access"> & { name?: string };
export const APP_ACCESS_RECHECK_MS = 50_000;
export const APP_ACCESS_CHECK_TIMEOUT_MS = 10_000;
const connections = new Set<() => void>();
/** app.start() closes sockets and SSE before draining the process's shared services. */
export const stopAppAccessConnections = (): void => {
  for (const close of [...connections]) close();
};

export const appAccessDeniedBody = (app: AccessApp) => ({
  code: "app_access_denied" as const,
  app: app.id,
  message: `You cannot use ${app.name ?? app.id}. ${app.access?.kind === "grants" ? "Ask someone who manages access to this app." : "Ask your Cloud administrator about access."}`,
});

export class AppAccessDeniedError extends Error {
  readonly code = "app_access_denied";
  constructor(readonly app: AccessApp) {
    super(appAccessDeniedBody(app).message);
  }
}

/** Public paths bypass this gate only; the route still owns its authentication. */
export const appPublicRouteMatcher = (app: AccessApp): ((path: string) => boolean) => {
  const router = new TrieRouter<boolean>();
  for (const path of app.access?.publicRoutes ?? []) router.add("ALL", path, true);
  return (path) => router.match("ALL", path)[0].length > 0;
};

/** Resolve afresh rather than reuse the original Context's authentication cache. */
export const appAccessRevalidator = (c: Context<AuthContext>, app: AccessApp): (() => Promise<boolean>) => {
  const original = appAccessAuthority(c);
  const sessionToken = c.get("sessionToken");
  const sessionKind = c.get("sessionKind");
  const samePrincipal = (current: RequestAuthority): boolean => {
    if (!original || current.accessSubject.type !== original.accessSubject.type) return false;
    if (
      current.accessSubject.type === "user" &&
      original.accessSubject.type === "user" &&
      current.accessSubject.userId !== original.accessSubject.userId
    )
      return false;
    if (
      current.accessSubject.type === "service_account" &&
      original.accessSubject.type === "service_account" &&
      current.accessSubject.serviceAccountId !== original.accessSubject.serviceAccountId
    )
      return false;
    if (current.credentialKind !== original.credentialKind || current.actor.kind !== original.actor.kind) return false;
    if (current.actor.kind === "user" && original.actor.kind === "user") return current.actor.user.id === original.actor.user.id;
    return (
      current.actor.kind === "service_account" &&
      original.actor.kind === "service_account" &&
      current.actor.serviceAccount.id === original.actor.serviceAccount.id &&
      current.actor.credentialId === original.actor.credentialId
    );
  };
  return async () => {
    if (!original || original.credentialKind === "invocation") return false;
    let allowed = false;
    const probe = new Hono<AuthContext>()
      .onError((error) => {
        throw error;
      })
      .use(auth.requireRole("*"))
      .all("*", async (fresh) => {
        const authority = appAccessAuthority(fresh);
        if (!authority || !samePrincipal(authority)) return fresh.body(null, 401);
        if (
          original.credentialKind === "session" &&
          (fresh.get("sessionToken") !== sessionToken || fresh.get("sessionKind") !== sessionKind)
        )
          return fresh.body(null, 401);
        // A stream retains its initial domain context. Reconnect on changed scopes so
        // neither a narrowed key nor an empty-scope personal key keeps stale authority.
        if (JSON.stringify([...new Set(authority.scopes)].sort()) !== JSON.stringify([...new Set(original.scopes)].sort()))
          return fresh.body(null, 401);
        allowed = await canUseApp(authority, app);
        return fresh.body(null, 204);
      });
    await probe.fetch(new Request(c.req.url, { headers: c.req.raw.headers }));
    return allowed;
  };
};

type WatchOptions = {
  check: () => Promise<boolean>;
  denied: () => void;
  subscribe: (changed: () => void) => () => void;
  intervalMs?: number;
  timeoutMs?: number;
};

/** One check in flight, coalesced invalidations, and a deadline that fails closed. */
export const watchAppAccess = (options: WatchOptions): (() => void) => {
  let stopped = false;
  let checking = false;
  let again = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(deadline);
    unsubscribe();
  };
  const deny = () => {
    if (stopped) return;
    stop();
    options.denied();
  };
  const check = async () => {
    if (stopped) return;
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    deadline = setTimeout(deny, options.timeoutMs ?? APP_ACCESS_CHECK_TIMEOUT_MS);
    try {
      if (!(await options.check())) deny();
    } catch {
      deny();
    } finally {
      clearTimeout(deadline);
      checking = false;
      if (again && !stopped) {
        again = false;
        void check();
      }
    }
  };
  const timer = setInterval(() => void check(), options.intervalMs ?? APP_ACCESS_RECHECK_MS);
  timer.unref?.();
  unsubscribe = options.subscribe(() => void check());
  // Close the race between the handshake's check and subscribing to changes.
  void check();
  return stop;
};

const subscribeApp = async (appId: string): Promise<(changed: () => void) => () => void> => {
  const { subscribeAppAccessChanged } = await import("../../events/app-access");
  return (changed) => subscribeAppAccessChanged(appId, changed);
};

/** Used by shared live updates and custom sockets; close always releases the watcher. */
export const guardAppAccessSocket = async (c: Context<AuthContext>, appId: string, events: WSEvents): Promise<WSEvents> => {
  let app: AccessApp | null;
  try {
    app = await getApp(appId);
  } catch {
    app = null;
  }
  if (app && (!app.access || appPublicRouteMatcher(app)(c.req.path))) return events;
  const authority = appAccessAuthority(c);
  if (!app || !(await canUseApp(authority, app))) {
    if (app) recordAppAccessDenied(app.id);
    return { onOpen: (_event, ws) => ws.close(1008, "app_access_denied") };
  }
  const revalidate = appAccessRevalidator(c, app);
  const subscribe = await subscribeApp(appId);
  let stop: (() => void) | undefined;
  let denied = false;
  let shutdown = () => {};
  return {
    ...events,
    onOpen: (event, ws) => {
      shutdown = () => {
        stop?.();
        connections.delete(shutdown);
        denied = true;
        ws.close(1012, "server_restarting");
      };
      connections.add(shutdown);
      stop = watchAppAccess({
        check: revalidate,
        subscribe,
        denied: () => {
          connections.delete(shutdown);
          denied = true;
          ws.close(1008, "app_access_denied");
        },
      });
      return events.onOpen?.(event, ws);
    },
    onMessage: (event, ws) => {
      if (!denied) return events.onMessage?.(event, ws);
    },
    onClose: (event, ws) => {
      connections.delete(shutdown);
      stop?.();
      return events.onClose?.(event, ws);
    },
    onError: (event, ws) => {
      connections.delete(shutdown);
      stop?.();
      ws.close(1011, "app_access_check_failed");
      return events.onError?.(event, ws);
    },
  };
};

const guardSse = async (c: Context<AuthContext>, app: AccessApp, response: Response): Promise<Response> => {
  if (!response.body) return response;
  const subscribe = await subscribeApp(app.id);
  const reader = response.body.getReader();
  let ended = false;
  let stop = () => {};
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abort = () => {
    if (!ended) streamController?.close();
    finish();
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    stop();
    connections.delete(abort);
    c.req.raw.signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      connections.add(abort);
      stop = watchAppAccess({
        check: appAccessRevalidator(c, app),
        subscribe,
        denied: () => {
          if (ended) return;
          controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(appAccessDeniedBody(app))}\n\n`));
          controller.close();
          finish();
        },
      });
      c.req.raw.signal.addEventListener("abort", abort, { once: true });
      if (c.req.raw.signal.aborted) {
        controller.close();
        finish();
      }
    },
    async pull(controller) {
      try {
        const item = await reader.read();
        if (ended) return;
        if (item.done) {
          controller.close();
          finish();
        } else controller.enqueue(item.value);
      } catch (error) {
        if (!ended) {
          controller.error(error);
          finish();
        }
      }
    },
    cancel: finish,
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

/** Framework gate: install after static and internal invocation mounts, before every app-owned handler. */
export const requireAppAccess = (
  app: AccessApp,
  renderDenied: (c: Context<AuthContext>, message: string) => Promise<Response>,
): MiddlewareHandler<AuthContext> => {
  const isPublic = appPublicRouteMatcher(app);
  return createMiddleware<AuthContext>(async (c, next) => {
    if (!app.access || isPublic(c.req.path)) return next();
    let resolved: RequestAuthority | null = null;
    await auth.requireRole("*")(c, async () => {
      resolved = appAccessAuthority(c);
    });
    const browser =
      c.req.method === "GET" && c.req.header("accept")?.includes("text/html") && c.req.header("upgrade")?.toLowerCase() !== "websocket";
    if (!resolved) {
      // Let the established mobile launch flow renew an app session.
      if (browser && c.req.path.startsWith("/pwa/")) {
        const url = new URL(c.req.url);
        return c.redirect(
          url.searchParams.has("pwa_launch")
            ? "/pwa/?pwa=unavailable"
            : `/pwa/_auth/session/launch?to=${encodeURIComponent(url.pathname + url.search)}`,
        );
      }
      return browser ? c.redirect(createLoginRedirectUrl(c.req.url)) : c.json({ message: "Authentication required" }, 401);
    }
    if (!(await canUseApp(resolved, app))) {
      recordAppAccessDenied(app.id);
      c.header("Cache-Control", "private, no-store");
      const body = appAccessDeniedBody(app);
      const response = browser ? await renderDenied(c, body.message) : c.json(body, 403);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("X-Cloud-App-Access-Denied", app.id);
      return response;
    }
    await next();
    if (c.res.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) c.res = await guardSse(c, app, c.res);
  });
};
