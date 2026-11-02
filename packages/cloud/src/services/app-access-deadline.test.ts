import { expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { bindAppAccessRequest } from "../_internal/app-access-request";
import { bindResourceAppAccess, resourceAppAccess } from "../_internal/app-access-resources";
import { createStatusPreservingSsrHandler } from "../_internal/status-preserving-ssr";
import { appAccess, compileAppAccess, type ResourceAppAccessAdapter } from "../contracts/app-access";
import type { AppRegistryEntry } from "../contracts/registry";
import type { AuthContext, RequestAuthority } from "../server/middleware/auth";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "../server/request-timeout";
import { getDisplayRuntimeContext } from "../ssr/runtime";
import { usableAppIds } from "./app-access";
import { buildProjectedUser } from "./session/user";

useUnitClients();
const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user", effective_admin: false });
const authority: RequestAuthority = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  credentialKind: "session",
  scopes: [],
};
const bind = (id: string, hasAnyRight: ResourceAppAccessAdapter["hasAnyRight"]) => {
  const declaration = appAccess.resources({ adapters: { workspace: { hasAnyRight } } });
  const app: AppRegistryEntry = {
    id,
    access: compileAppAccess(declaration),
    name: id,
    description: id,
    icon: "ti ti-apps",
    baseUrl: "http://fixture.invalid",
    routes: [`/app/${id}`],
  };
  return { app, stop: bindResourceAppAccess(id, declaration) };
};

test("an app page answers with healthy apps despite a stalled owner, and the next request sees revocation", async () => {
  setSystemTime(new Date("2026-11-02T09:00:00Z"));
  let right = true;
  let slowAborted = false;
  const started: string[] = [];
  const fixtures = [
    bind("stalled", async (_subject, { signal }) => {
      signal.addEventListener(
        "abort",
        () => {
          slowAborted = true;
        },
        { once: true },
      );
      return new Promise<boolean>(() => {}); // Even an adapter ignoring cancellation cannot hold the page.
    }),
    bind("broken", async () => {
      throw new Error("owner unavailable");
    }),
    ...Array.from({ length: 7 }, (_, i) =>
      bind(`healthy-${i}`, async () => {
        started.push(`healthy-${i}`);
        return right;
      }),
    ),
  ];
  const apps = fixtures.map(({ app }) => app);
  const ssr = createStatusPreservingSsrHandler(
    async (render) => new Response(String(render()), { headers: { "content-type": "text/html" } }),
  );
  const server = new Hono<AuthContext & { Variables: { runtime: { apps: AppRegistryEntry[] } } }>()
    .use(async (c, next) => {
      const current = bindAppAccessRequest(authority, c.req.raw);
      c.set("actor", current.actor);
      c.set("accessSubject", current.accessSubject);
      c.set("credentialKind", current.credentialKind);
      c.set("runtime", { apps });
      await next();
    })
    .get("/app/assistant", ...ssr((c) => () => JSON.stringify(getDisplayRuntimeContext(c).apps.map(({ id }) => id))));
  try {
    const response = await server.request("/app/assistant");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(apps.slice(2).map(({ id }) => id));
    expect(started).toHaveLength(7);
    expect(slowAborted).toBe(true);
    right = false;
    expect(await (await server.request("/app/assistant")).json()).toEqual([]);
  } finally {
    for (const fixture of fixtures) fixture.stop();
    setSystemTime();
  }
}, 4000);

test("a full queue has a shared deadline below the server idle timeout even with an unbounded caller signal", async () => {
  let active = 0;
  let peak = 0;
  let started = 0;
  const fixtures = Array.from({ length: 40 }, (_, i) =>
    bind(`queued-${i}`, async (_subject, { signal }) => {
      started++;
      active++;
      peak = Math.max(peak, active);
      return new Promise<boolean>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            active--;
            resolve(false);
          },
          { once: true },
        ),
      );
    }),
  );
  const begin = performance.now();
  try {
    expect(
      await usableAppIds(
        authority,
        fixtures.map(({ app }) => app),
        { signal: new AbortController().signal },
      ),
    ).toEqual(new Set());
    expect(performance.now() - begin).toBeLessThan((REQUEST_IDLE_TIMEOUT_SECONDS * 1000) / 2);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(started).toBeLessThan(fixtures.length);
  } finally {
    for (const fixture of fixtures) fixture.stop();
  }
}, 6000);

test("one wave timing out leaves a fresh per-app budget for queued healthy owners", async () => {
  const signals = new Set<AbortSignal>();
  const fixtures = [
    ...Array.from({ length: 4 }, (_, i) =>
      bind(`slow-${i}`, async (_subject, { signal }) => {
        signals.add(signal);
        return new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
      }),
    ),
    bind("later-healthy", async (_subject, { signal }) => {
      expect(signal.aborted).toBe(false);
      return true;
    }),
  ];
  try {
    expect(
      await usableAppIds(
        authority,
        fixtures.map(({ app }) => app),
      ),
    ).toEqual(new Set(["later-healthy"]));
    expect(signals.size).toBe(4);
  } finally {
    for (const fixture of fixtures) fixture.stop();
  }
}, 2500);

test("slow probe diagnostics identify the hop and phase, throttle repeated probes and omit authority", async () => {
  setSystemTime(new Date("2026-11-02T10:00:00Z"));
  const logging = await import("./logging");
  const warnings: { message: string; metadata?: Record<string, unknown> }[] = [];
  const original = logging.logger;
  const logger = spyOn(logging, "logger").mockImplementation((source) => ({
    ...original(source),
    warn: (message, metadata) => warnings.push({ message, metadata }),
  }));
  let wallTime = Date.now();
  const wallClock = spyOn(Date, "now").mockImplementation(() => wallTime);
  const fixture = bind("timing-fixture", async () => {
    // fixed wait: cross the 250 ms slow-probe logging threshold.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return true;
  });
  try {
    for (let i = 0; i < 2; i++) expect(await resourceAppAccess({ ...authority }, fixture.app)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.metadata).toMatchObject({
      appId: fixture.app.id,
      hop: "owner",
      outcome: "allowed",
      slowProbeCount: 1,
      timings: { adapter: expect.any(Number) },
    });
    wallTime += 61_000;
    await resourceAppAccess({ ...authority }, fixture.app);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]?.metadata?.slowProbeCount).toBe(2);
    expect(JSON.stringify(warnings)).not.toContain(user.id);
    expect(Object.keys(warnings[0]?.metadata ?? {}).sort()).toEqual(["appId", "elapsedMs", "hop", "outcome", "slowProbeCount", "timings"]);
  } finally {
    fixture.stop();
    logger.mockRestore();
    wallClock.mockRestore();
    setSystemTime();
  }
});
