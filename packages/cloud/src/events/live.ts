import type { ServerWebSocket } from "bun";
import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { z } from "zod";
import { guardAppAccessSocket } from "../server/middleware/app-access";
import { type AuthContext, auth } from "../server/middleware/auth";
import { rateLimit } from "../server/middleware/rate-limit";
import * as settings from "../services/settings";
import { publicCloudOrigin } from "../shared/app-url";
import { defineLivePublisher, liveTopic, startLiveDelivery } from "./live-delivery";
import { createLiveEngine, type LiveChannel, type LiveConnectionHandle, type LiveEngine, type LiveViewer } from "./live-engine";

export { liveOutbox, liveTopicConfig } from "./live-delivery";
export type { LiveChannel, LiveViewer } from "./live-engine";

/** Applications whose live socket this process mounts; only the started application may be among them. */
const served = new Set<string>();
/** Live sockets served by this process; they close when the application stops. */
const engines = new Set<LiveEngine>();
/** Set when the application stops delivery: its engines stay stopped until delivery starts again. */
let stopped = false;

/** Closes every live socket of this process with 1012, so clients reconnect to another replica. */
export const stopLiveEngines = () => {
  stopped = true;
  for (const engine of engines) engine.stop();
};

/** Starts delivery only for the application whose live sockets this process serves. */
export const startLiveOutbox = async (appId: string): Promise<(() => Promise<void>) | null> => {
  const foreign = [...served].filter((other) => other !== appId);
  if (foreign.length > 0) {
    throw new Error(
      `This process mounts the live socket of "${foreign.join('", "')}", but starts "${appId}". Use the ID from the application's declaration.`,
    );
  }
  const stopDelivery = await startLiveDelivery(appId);
  if (!stopDelivery) return null;
  // Delivery starts again: the engines stopped before give way to new ones.
  if (stopped) {
    engines.clear();
    stopped = false;
  }
  return async () => {
    stopLiveEngines();
    await stopDelivery();
  };
};

/**
 * The viewer of an authenticated request. Its ID separates every credential of
 * one principal that can decide differently: an app session holds no `admin`
 * role, and an API key or OAuth token is limited by its scopes.
 */
const viewerOf = <Env extends AuthContext>(c: Context<Env>): LiveViewer => {
  const accessSubject = c.get("accessSubject");
  const scopes = c.get("credentialScopes") ?? [];
  const principal = accessSubject.type === "user" ? `user:${accessSubject.userId}` : `service_account:${accessSubject.serviceAccountId}`;
  const credential =
    c.get("credentialKind") === "session"
      ? c.get("sessionKind") === "app"
        ? ":app"
        : ""
      : `:scopes=${[...new Set(scopes)].sort().join(",")}`;
  return { id: `${principal}${credential}`, actor: c.get("actor"), accessSubject, scopes };
};

type ProbeEnv = AuthContext & { Bindings: { found: (viewer: LiveViewer) => void } };

/** The ordinary credential check of every API request, run again for an open socket. */
const probe = new Hono<ProbeEnv>()
  .onError((error) => {
    throw error;
  })
  .get("*", auth.requireRole("authenticated"), (c) => {
    c.env.found(viewerOf(c));
    return c.body(null, 204);
  });

/** Checks the socket's credential again: `null` once the session or token is no longer valid. */
const revalidator = (c: Context<AuthContext>) => {
  const headers = new Headers();
  for (const name of ["cookie", "authorization"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const path = c.req.path;
  return async (): Promise<LiveViewer | null> => {
    let viewer: LiveViewer | null = null;
    await probe.request(path, { headers }, { found: (found: LiveViewer) => (viewer = found) });
    return viewer;
  };
};

type Refusal = { code: "login_required" | "forbidden_origin" | "missing_scope"; message: string };

/**
 * Why the socket may not serve this request. The refusal is sent on an
 * accepted socket, with close code 1008: the gateway accepts the browser's
 * socket before it reaches the application and would turn a refused handshake
 * into a retryable 1012.
 */
const refusalOf = async (c: Context<AuthContext>): Promise<Refusal | null> => {
  if (!c.get("actor")) return { code: "login_required", message: "Sign in again to receive live updates." };
  // A session cookie travels with every page of the browser, so a browser's socket must come from Cloud's own origin.
  // Browsers always send Origin on a socket; a client without one is no page that another site could have opened.
  const origin = c.req.header("Origin");
  if (
    c.get("credentialKind") === "session" &&
    origin !== undefined &&
    origin !== publicCloudOrigin(await settings.get<string>("app.url"))
  ) {
    return { code: "forbidden_origin", message: "Live sockets signed in with a session must come from the Cloud origin." };
  }
  const oauthScopes = c.get("oauthScopes");
  if (oauthScopes && !oauthScopes.includes("read") && !oauthScopes.includes("admin")) {
    return { code: "missing_scope", message: "Live updates need an OAuth token with the read scope." };
  }
  return null;
};

/**
 * Live updates of one application: hints, optionally with data, for its own
 * open tabs. Define them once at module scope; `app.start()` then publishes the
 * rows that `publish()` writes, and `routes()` serves them to browsers.
 * `appId` is required and is never derived from the process. Another
 * application's process may hold the definition to read its `cursor()` or
 * write updates; only the application itself publishes and serves them.
 */
export const defineLive = <const Event extends z.ZodType>(definition: { appId: string; event: Event }) => {
  const { appId } = definition;
  return {
    ...defineLivePublisher(definition),
    /**
     * The live socket with these channels. Mount it once, at `/api/<app>/live`,
     * in the application's own process: `app.start()` of another application fails.
     * It authenticates like any API request; a session needs the Cloud origin
     * and an OAuth token the `read` scope. A refused socket receives `error`
     * and closes with 1008. Channels are passed here, not to
     * `defineLive()`, because they check access with the domain services that
     * themselves publish updates.
     */
    routes: <const Scopes extends Record<string, z.ZodType>>(channels: { [Name in keyof Scopes]: LiveChannel<Scopes[Name]> }) => {
      served.add(appId);
      let engine: LiveEngine | null = null;
      const serve = (): LiveEngine => {
        if (engine && engines.has(engine)) return engine;
        engine = createLiveEngine({ appId, topic: () => liveTopic(appId), channels });
        engines.add(engine);
        // A socket that opens while the application stops closes with 1012 and starts nothing.
        if (stopped) engine.stop();
        return engine;
      };
      return new Hono<AuthContext>().get(
        "/",
        rateLimit({ limitPerSecond: 5 }),
        auth.requireRole("*"),
        upgradeWebSocket(async (c) => {
          const refusal = await refusalOf(c);
          if (refusal) {
            return {
              onOpen: (_event, ws) => {
                ws.send(JSON.stringify({ t: "error", ...refusal }));
                ws.close(1008, refusal.code);
              },
            };
          }
          const viewer = viewerOf(c);
          const revalidate = revalidator(c);
          let connection: LiveConnectionHandle | null = null;
          return guardAppAccessSocket(c, appId, {
            onOpen: (_event, ws) => {
              connection = serve().open(ws.raw as ServerWebSocket<unknown>, viewer, revalidate);
            },
            onMessage: (message) => connection?.message(message.data),
            onClose: () => connection?.closed(),
          });
        }),
      );
    },
  };
};
