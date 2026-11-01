import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { guardAppAccessSocket } from "../server/middleware/app-access";
import { type AuthContext, auth } from "../server/middleware/auth";
import { rateLimit } from "../server/middleware/rate-limit";
import { coreSettings } from "../services/settings/api";
import { publicCloudOrigin } from "../shared/app-url";
import { getLiveDictationStatus, LiveDictationError, resolveLiveDictationModel } from "./live-dictation-model";
import { createLiveDictationSession, type LiveDictationCode } from "./live-dictation-runtime";

const sessions = new Set<ReturnType<typeof createLiveDictationSession>>();
/** Core drains model connections before releasing native clients. */
export const stopLiveDictationSessions = async () => {
  const active = [...sessions];
  for (const session of active) session.abort();
  await Promise.all(active.map((session) => session.settled()));
  sessions.clear();
};
const validSession = (c: Context<AuthContext>) => c.get("credentialKind") === "session" && c.get("accessSubject")?.type === "user";
export const liveDictationOriginAllowed = (origin: string | undefined, appUrl: string) => origin === publicCloudOrigin(appUrl);
type Probe = AuthContext & {
  Bindings: { found(session: { kind: string | undefined; subject: import("../server/services/access").AccessSubject }): Promise<void> };
};
const probe = new Hono<Probe>()
  .onError((error) => {
    throw error;
  })
  .get("*", auth.requireRole("authenticated"), async (c) => {
    await c.env.found({ kind: c.get("credentialKind"), subject: c.get("accessSubject") });
    return c.body(null, 204);
  });
export const createLiveDictationRevalidator = (c: Context<AuthContext>, profileId: string, userId: string) => {
  const headers = new Headers();
  const cookie = c.req.header("cookie");
  if (cookie) headers.set("cookie", cookie);
  return async () => {
    let allowed = false;
    await probe.request(
      c.req.path,
      { headers },
      {
        found: async (fresh: { kind: string | undefined; subject: import("../server/services/access").AccessSubject }) => {
          if (fresh.kind !== "session") return;
          const subject = fresh.subject;
          if (subject.type !== "user" || subject.userId !== userId) return;
          try {
            allowed = (await resolveLiveDictationModel(subject)).id === profileId;
          } catch (error) {
            if (!(error instanceof LiveDictationError)) throw error;
            allowed = false;
          }
        },
      },
    );
    return allowed;
  };
};

/** Core owns /api/ai, so all apps share one endpoint and the same authorization. */
export const aiDictationRoutes = new Hono<AuthContext>()
  .use("*", rateLimit({ limitPerSecond: 5 }))
  .use("*", auth.requireRole("*"))
  .get("/status", async (c) =>
    c.json(validSession(c) ? await getLiveDictationStatus(c.get("accessSubject")) : { available: false, reason: "no_access" }),
  )
  .get(
    "/live",
    upgradeWebSocket(async (c) => {
      const refuse = (code: LiveDictationCode) => ({
        onOpen: (_event: unknown, ws: { send(value: string): void; close(code: number, reason: string): void }) => {
          ws.send(JSON.stringify({ type: "error", code, retryable: false }));
          ws.close(1008, code);
        },
      });
      if (!validSession(c) || !liveDictationOriginAllowed(c.req.header("origin"), await coreSettings.get<string>("app.url")))
        return refuse("no_access");
      const subject = c.get("accessSubject");
      if (subject.type !== "user") return refuse("no_access");
      let profile: Awaited<ReturnType<typeof resolveLiveDictationModel>>;
      try {
        profile = await resolveLiveDictationModel(subject);
      } catch (error) {
        return refuse(error instanceof Error && "code" in error && error.code === "no_access" ? "no_access" : "not_configured");
      }
      const [concurrency, minutesPerDay, timeZone] = await Promise.all([
        coreSettings.get<number>("ai.live_dictation_concurrency"),
        coreSettings.get<number>("ai.live_dictation_minutes_per_day"),
        coreSettings.get<string>("app.timezone"),
      ]);
      let session: ReturnType<typeof createLiveDictationSession> | undefined;
      return guardAppAccessSocket(c, "core", {
        onOpen: (_event, ws) => {
          session = createLiveDictationSession({
            userId: subject.userId,
            profile,
            concurrency,
            minutesPerDay,
            timeZone: timeZone || "UTC",
            send: (event) => ws.send(JSON.stringify(event)),
            close: (code, reason) => ws.close(code, reason),
            revalidate: createLiveDictationRevalidator(c, profile.id, subject.userId),
          });
          sessions.add(session);
        },
        onMessage: (event) => {
          if (typeof event.data === "string" || event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data))
            session?.receive(event.data);
          else session?.abort();
        },
        onClose: () => {
          if (session) {
            session.abort();
            sessions.delete(session);
          }
        },
        onError: () => {
          if (session) {
            session.abort();
            sessions.delete(session);
          }
        },
      });
    }),
  );
