import { describe, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import type { MiddlewareHandler } from "hono";
import { generateKeyPair } from "jose";
import type { DashboardWidget } from "../_internal/registry";
import type { WidgetStreamLine } from "../contracts/widgets";
import type { AuthContext } from "../server";
import type { signInvocationToken } from "../services/identity/invocation-token";
import type { withActiveIdentitySigner } from "../services/identity/key-ring";
import { createWidgetRoutes as buildWidgetRoutes, WIDGET_CONCURRENCY } from "./widgets";

const user = { id: "11111111-1111-4111-8111-111111111111", roles: ["user"] } as AuthContext["Variables"]["user"];
const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  c.set("credentialKind", "session");
  c.set("credentialScopes", []);
  await next();
};

const authenticateWorkload =
  (scope: "identity:invoke" | "identity:oauth-issue"): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    const serviceAccountId = "22222222-2222-4222-8222-222222222222";
    c.set("actor", {
      kind: "service_account",
      serviceAccount: {
        id: serviceAccountId,
        name: "App workload",
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: "assistant",
        resourceType: "cloud.app",
        resourceId: "assistant",
        createdBy: null,
        createdAt: "2026-09-02T00:00:00.000Z",
      },
      delegatedUser: null,
      scopes: [scope],
    });
    c.set("accessSubject", { type: "service_account", serviceAccountId });
    c.set("credentialKind", "api_key");
    c.set("credentialScopes", [scope]);
    await next();
  };

const widget: DashboardWidget = {
  appId: "weather",
  appName: "Weather",
  appIcon: "ti ti-cloud",
  widgetId: "current",
  url: "http://app-weather:3000/api/weather/widget/current",
  title: "Weather",
  description: "Current weather",
  sizes: ["small", "medium"],
  defaultSize: "small",
  suggest: true,
  requiresRoles: [],
};

let signerKey: CryptoKey | undefined;
const withActiveSigner: typeof withActiveIdentitySigner = async (_purpose, callback) => {
  signerKey ??= (await generateKeyPair("RS256")).privateKey;
  return callback(
    { kid: "33333333-3333-4333-8333-333333333333", key: signerKey, issuer: "https://cloud.test", signUntil: new Date(Date.now() + 60_000) },
    sql,
  );
};

const createWidgetRoutes = (dependencies: Parameters<typeof buildWidgetRoutes>[0] = {}) =>
  buildWidgetRoutes({
    withActiveSigner,
    signInvocation: async () => ({ token: "target-token" }) as Awaited<ReturnType<typeof signInvocationToken>>,
    ...dependencies,
  });

describe("Core widget proxy", () => {
  test("requires an OAuth read scope before registry lookup or invocation issuance", async () => {
    for (const scopes of [[], ["openid", "profile"], ["write"], ["read"], ["admin"]]) {
      let registryCalls = 0;
      let signingCalls = 0;
      let providerCalls = 0;
      const routes = createWidgetRoutes({
        authenticate: async (c, next) => {
          c.set("actor", { kind: "user", user });
          c.set("accessSubject", { type: "user", userId: user.id });
          c.set("credentialKind", "oauth");
          c.set("credentialScopes", scopes);
          c.set("oauthScopes", scopes);
          await next();
        },
        listWidgets: async () => {
          registryCalls += 1;
          return [widget];
        },
        signInvocation: async () => {
          signingCalls += 1;
          return { token: "target-token" } as Awaited<ReturnType<typeof signInvocationToken>>;
        },
        fetch: async () => {
          providerCalls += 1;
          return Response.json({ title: "Weather", blocks: [] });
        },
      });
      const allowed = scopes.includes("read") || scopes.includes("admin");
      const response = await routes.request("/widgets/v1/weather/current");
      expect(response.status).toBe(allowed ? 200 : 403);
      expect([registryCalls, signingCalls, providerCalls]).toEqual(allowed ? [1, 1, 1] : [0, 0, 0]);
    }
  });

  test("drops invalid optional request ids before signing and forwarding", async () => {
    {
      for (const requestId of ["two words", "ümlaut", "x".repeat(201)]) {
        let called = false;
        const routes = createWidgetRoutes({
          authenticate,
          listWidgets: async () => [widget],
          withActiveSigner,
          signInvocation: async (params) => {
            called = true;
            expect(params.requestId).toBeUndefined();
            return { token: "target-token" } as Awaited<ReturnType<typeof signInvocationToken>>;
          },
          fetch: async (_input, init) => {
            expect(new Headers(init?.headers).has("x-request-id")).toBeFalse();
            return Response.json({ title: "Weather", blocks: [] });
          },
        });
        const response = await routes.request("/widgets/v1/weather/current", { headers: { "x-request-id": requestId } });
        expect(response.status).toBe(200);
        expect(called).toBeTrue();
      }
    }
  });

  test("always uses the invocation-only target, even for a browser cookie", async () => {
    {
      const captured: { target?: URL; headers?: Headers } = {};
      const routes = createWidgetRoutes({
        authenticate,
        listWidgets: async () => [widget],
        fetch: async (input, init) => {
          captured.target = new URL(input instanceof Request ? input.url : input);
          captured.headers = new Headers(init?.headers);
          return new Response(null, { status: 204 });
        },
      });

      const response = await routes.request("/widgets/v1/weather/current", { headers: { cookie: "theme=dark; session_token=session" } });
      expect(response.status).toBe(204);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(captured.target?.href).toBe("http://app-weather:3000/api/_internal/widgets/v1/current?size=small");
      expect(captured.headers?.get("cookie")).toBeNull();
      expect(captured.headers?.get("authorization")).toBe("Bearer target-token");
    }
  });

  test("JWT mode issues an exact target token and never forwards the source credential", async () => {
    {
      let signed: Parameters<typeof signInvocationToken>[0] | null = null;
      let receivedSigner = false;
      let guardCalls = 0;
      const captured: { headers?: Headers } = {};
      const capturedTarget: { url?: URL } = {};
      const routes = createWidgetRoutes({
        authenticate,
        listWidgets: async () => [widget],
        withActiveSigner: async (purpose, callback, options) => {
          guardCalls += 1;
          return withActiveSigner(purpose, callback, options);
        },
        signInvocation: (async (params) => {
          signed = params;
          receivedSigner = params.signer !== undefined;
          return { token: "target-token" } as Awaited<ReturnType<typeof signInvocationToken>>;
        }) as typeof signInvocationToken,
        fetch: async (input, init) => {
          capturedTarget.url = new URL(input instanceof Request ? input.url : input);
          captured.headers = new Headers(init?.headers);
          return Response.json({ title: "Weather", blocks: [] });
        },
      });

      const response = await routes.request("/widgets/v1/weather/current", {
        headers: { authorization: "Bearer source-oauth", cookie: "cloud_session=session", "x-cloud-locale": "de-CH" },
      });

      expect(response.status).toBe(200);
      expect(guardCalls).toBe(1);
      expect(response.headers.get("content-type")).toStartWith("application/json");
      expect(capturedTarget.url?.href).toBe("http://app-weather:3000/api/_internal/widgets/v1/current?size=small");
      expect(signed).toMatchObject({
        targetAppId: "weather",
        callingAppId: "core",
        operation: "widget.read:current",
        schemaHash: null,
        authority: {
          sub: user.id,
          access_subject_id: user.id,
          credential_kind: "session",
        },
      });
      expect(receivedSigner).toBeTrue();
      expect(captured.headers?.get("authorization")).toBe("Bearer target-token");
      expect(captured.headers?.get("cookie")).toBeNull();
      expect(captured.headers?.get("x-cloud-locale")).toBe("de-CH");
      expect(captured.headers?.get("x-cloud-invocation-operation")).toBe("widget.read:current");
    }
  });

  test("does not proxy undeclared widget targets", async () => {
    const routes = createWidgetRoutes({ authenticate, listWidgets: async () => [widget] });
    expect((await routes.request("/widgets/v1/weather/missing")).status).toBe(404);
    expect((await routes.request("/widgets/v1/other/current")).status).toBe(404);
  });

  for (const scope of ["identity:invoke", "identity:oauth-issue"] as const) {
    test(`rejects ${scope} before public widget proxy dispatch`, async () => {
      let fetched = false;
      const routes = createWidgetRoutes({
        authenticate: authenticateWorkload(scope),
        listWidgets: async () => [widget],
        fetch: async () => {
          fetched = true;
          return Response.json({ title: "Unsafe", blocks: [] });
        },
      });
      const response = await routes.request("/widgets/v1/weather/current");
      expect(response.status).toBe(403);
      expect(fetched).toBeFalse();
    });
  }

  test("validates and reserializes provider JSON without forwarding foreign response metadata", async () => {
    {
      const routes = createWidgetRoutes({
        authenticate,
        listWidgets: async () => [widget],
        fetch: async () =>
          new Response(JSON.stringify({ title: "Weather", href: "/app/weather", blocks: [] }), {
            headers: { "content-type": "text/html", "set-cookie": "foreign=secret" },
          }),
      });
      const response = await routes.request("/widgets/v1/weather/current");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("application/json");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toEqual({ title: "Weather", href: "/app/weather", blocks: [] });
    }
  });

  test("rejects unsafe links and oversized bodies instead of forwarding them", async () => {
    const providers = [
      () => Response.json({ title: "Unsafe", href: "javascript:alert(1)", blocks: [] }),
      () => new Response(JSON.stringify({ title: "Huge", blocks: [], padding: "x".repeat(140 * 1024) })),
    ];
    for (const provider of providers) {
      const routes = createWidgetRoutes({ authenticate, listWidgets: async () => [widget], fetch: async () => provider() });
      const response = await routes.request("/widgets/v1/weather/current");
      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toStartWith("application/json");
    }
  });

  test("bounds registry and invocation signing inside the proxy deadline", async () => {
    {
      const routes = createWidgetRoutes({
        authenticate,
        timeoutMs: 5,
        listWidgets: async () => [widget],
        withActiveSigner,
        signInvocation: (() => new Promise(() => {})) as typeof signInvocationToken,
      });
      const response = await routes.request("/widgets/v1/weather/current");
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ message: "Widget deadline exceeded" });
    }
  });

  test("preserves safe external links while stripping provider extension fields", async () => {
    const routes = createWidgetRoutes({
      authenticate,
      listWidgets: async () => [widget],
      fetch: async () => Response.json({ title: "Weather", href: "https://weather.example/forecast", blocks: [], extension: "ignored" }),
    });
    const response = await routes.request("/widgets/v1/weather/current");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "Weather", href: "https://weather.example/forecast", blocks: [] });
  });

  test("logs bounded rejection reasons without provider bodies or thrown error details", async () => {
    const warnings: unknown[][] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    try {
      const routes = createWidgetRoutes({
        authenticate,
        listWidgets: async () => [widget],
        fetch: async () => Response.json({ title: "Private provider payload", blocks: [{ kind: "unknown" }] }),
      });
      expect((await routes.request("/widgets/v1/weather/current")).status).toBe(502);
      expect(warnings).toEqual([
        [
          "[widgets]",
          "Widget proxy rejected response",
          {
            appId: "weather",
            widgetId: "current",
            phase: "response",
            reason: "invalid_schema",
          },
        ],
      ]);
      expect(JSON.stringify(warnings)).not.toContain("Private provider payload");
    } finally {
      warn.mockRestore();
    }
  });

  test("preserves timeout classification for provider TimeoutError and HTTP 504", async () => {
    for (const fetch of [
      async () => {
        throw new DOMException("private timeout detail", "TimeoutError");
      },
      async () => new Response("private timeout detail", { status: 504 }),
    ]) {
      const routes = createWidgetRoutes({ authenticate, listWidgets: async () => [widget], fetch });
      const response = await routes.request("/widgets/v1/weather/current");
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ message: "Widget deadline exceeded" });
    }
  });
});

const widgetsFor = (count: number): DashboardWidget[] =>
  Array.from({ length: count }, (_, index) => ({
    appId: `app-${index}`,
    appName: `App ${index}`,
    appIcon: "ti ti-box",
    widgetId: "summary",
    url: `http://app-${index}:3000/api/app-${index}/widget/summary`,
    title: "Summary",
    description: `App ${index} summary`,
    sizes: ["small", "medium", "large"],
    defaultSize: "medium",
    suggest: false,
    requiresRoles: [],
  }));

const appOf = (input: string | URL | Request) => new URL(input instanceof Request ? input.url : input).hostname.split(":")[0]!;

/** Reads the NDJSON stream and records when each line arrived relative to the others. */
const readLines = async (response: Response): Promise<WidgetStreamLine[]> =>
  (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WidgetStreamLine);

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

describe("Core widget stream", () => {
  test("streams each widget as it finishes so a slow widget never holds back the others", async () => {
    const slow = gate();
    const routes = createWidgetRoutes({
      authenticate,
      listWidgets: async () => widgetsFor(3),
      fetch: async (input) => {
        const app = appOf(input);
        if (app === "app-0") await slow.opened;
        return Response.json({ title: app, blocks: [] });
      },
    });
    const response = await routes.request("/widgets/v1");
    expect(response.headers.get("content-type")).toStartWith("application/x-ndjson");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (text.split("\n").filter(Boolean).length < 3) text += (await reader.read()).value ?? "";
    const early = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WidgetStreamLine);
    expect(early[0]).toEqual({ type: "start", widgets: ["app-0/summary", "app-1/summary", "app-2/summary"] });
    expect(early.slice(1).map((line) => (line.type === "widget" ? line.key : line.type))).toEqual(["app-1/summary", "app-2/summary"]);

    slow.open();
    while (!text.includes('"done"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += chunk.value;
    }
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WidgetStreamLine);
    expect(lines.at(-2)).toMatchObject({ type: "widget", key: "app-0/summary", status: "ok", widget: { title: "app-0", blocks: [] } });
    expect(lines.at(-1)).toEqual({ type: "done", status: "complete" });
  });

  test("gives each widget its own budget and reports a slow or failing app only on its own line", async () => {
    const routes = createWidgetRoutes({
      authenticate,
      timeoutMs: 50,
      listWidgets: async () => widgetsFor(4),
      fetch: async (input, init) => {
        const app = appOf(input);
        if (app === "app-0")
          return new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
          );
        if (app === "app-1") return new Response("boom", { status: 500 });
        if (app === "app-2") return new Response(null, { status: 403 });
        return new Response(null, { status: 204 });
      },
    });
    const lines = await readLines(await routes.request("/widgets/v1"));
    const byKey = Object.fromEntries(lines.flatMap((line) => (line.type === "widget" ? [[line.key, line.status]] : [])));
    expect(byKey).toEqual({
      "app-0/summary": "timeout",
      "app-1/summary": "error",
      "app-2/summary": "forbidden",
      "app-3/summary": "empty",
    });
    expect(lines.at(-1)).toEqual({ type: "done", status: "partial" });
  });

  test("asks only the requested widgets, in registry order, and ignores unknown or repeated keys", async () => {
    const asked: string[] = [];
    const routes = createWidgetRoutes({
      authenticate,
      listWidgets: async () => widgetsFor(4),
      fetch: async (input) => {
        asked.push(appOf(input));
        return Response.json({ title: "ok", blocks: [] });
      },
    });
    const lines = await readLines(
      await routes.request("/widgets/v1?widget=app-3/summary&widget=app-1/summary&widget=app-3/summary&widget=missing/summary"),
    );
    expect(lines[0]).toEqual({ type: "start", widgets: ["app-1/summary", "app-3/summary"] });
    expect(asked.sort()).toEqual(["app-1", "app-3"]);
    expect(lines.filter((line) => line.type === "widget")).toHaveLength(2);
  });

  test("asks each widget for the size the board shows it in, and its default size for a size it does not offer", async () => {
    const asked: Record<string, string | null> = {};
    const routes = createWidgetRoutes({
      authenticate,
      listWidgets: async () => [...widgetsFor(3), widget],
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        asked[url.hostname] = url.searchParams.get("size");
        return Response.json({ title: "ok", blocks: [] });
      },
    });
    const lines = await readLines(
      await routes.request(
        "/widgets/v1?widget=app-0/summary@large&widget=app-1/summary&widget=app-2/summary@huge&widget=weather/current@large",
      ),
    );
    // `@huge` is not a size, so it is part of the key and asks no widget.
    expect(lines[0]).toEqual({ type: "start", widgets: ["app-0/summary", "app-1/summary", "weather/current"] });
    expect(asked).toEqual({ "app-0": "large", "app-1": "medium", "app-weather": "small" });

    // A widget whose own ID ends in a size suffix is still asked by its ID.
    const suffixed: DashboardWidget = { ...widget, appId: "legacy", widgetId: "stats@small", url: "http://app-legacy:3000/widget" };
    const legacy = createWidgetRoutes({
      authenticate,
      listWidgets: async () => [suffixed],
      fetch: async () => Response.json({ title: "ok", blocks: [] }),
    });
    expect((await readLines(await legacy.request("/widgets/v1?widget=legacy/stats@small")))[0]).toEqual({
      type: "start",
      widgets: ["legacy/stats@small"],
    });

    const single = await routes.request("/widgets/v1/weather/current?size=medium");
    expect(single.status).toBe(200);
    expect(asked["app-weather"]).toBe("medium");
  });

  test("runs at most eight providers at once and signs the whole dashboard under one guard", async () => {
    let running = 0;
    let peak = 0;
    let guardCalls = 0;
    let signed = 0;
    const routes = createWidgetRoutes({
      authenticate,
      listWidgets: async () => widgetsFor(20),
      withActiveSigner: async (purpose, callback, options) => {
        guardCalls += 1;
        return withActiveSigner(purpose, callback, options);
      },
      signInvocation: async () => {
        signed += 1;
        return { token: "target-token" } as Awaited<ReturnType<typeof signInvocationToken>>;
      },
      fetch: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await Bun.sleep(5);
        running -= 1;
        return Response.json({ title: "ok", blocks: [] });
      },
    });
    const lines = await readLines(await routes.request("/widgets/v1"));
    expect(lines.filter((line) => line.type === "widget" && line.status === "ok")).toHaveLength(20);
    expect(peak).toBe(WIDGET_CONCURRENCY);
    expect([guardCalls, signed]).toEqual([1, 20]);
  });

  test("never forwards the browser credential and validates every provider answer", async () => {
    const headers: Headers[] = [];
    const routes = createWidgetRoutes({
      authenticate,
      listWidgets: async () => widgetsFor(2),
      fetch: async (input, init) => {
        headers.push(new Headers(init?.headers));
        return appOf(input) === "app-0"
          ? Response.json({ title: "Unsafe", href: "javascript:alert(1)", blocks: [] })
          : Response.json({ title: "Fine", blocks: [], extension: "ignored" });
      },
    });
    const lines = await readLines(
      await routes.request("/widgets/v1", { headers: { cookie: "cloud_session=session", "x-cloud-locale": "de-CH" } }),
    );
    const byKey = Object.fromEntries(lines.flatMap((line) => (line.type === "widget" ? [[line.key, line]] : [])));
    expect(byKey["app-0/summary"]).toMatchObject({ status: "error" });
    expect(byKey["app-1/summary"]).toMatchObject({ status: "ok", widget: { title: "Fine", blocks: [] } });
    expect(JSON.stringify(byKey["app-1/summary"])).not.toContain("extension");
    for (const header of headers) {
      expect(header.get("cookie")).toBeNull();
      expect(header.get("authorization")).toBe("Bearer target-token");
      expect(header.get("x-cloud-locale")).toBe("de-CH");
    }
  });

  test("stops every provider it still waits for when the browser stops reading, without logging a failure", async () => {
    const warnings: unknown[][] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    try {
      const aborted: string[] = [];
      let started = 0;
      const running = gate();
      const routes = createWidgetRoutes({
        authenticate,
        // Eight run, two wait for a free place.
        listWidgets: async () => widgetsFor(WIDGET_CONCURRENCY + 2),
        fetch: async (input, init) =>
          new Promise<Response>((_resolve, reject) => {
            started += 1;
            if (started === WIDGET_CONCURRENCY) running.open();
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted.push(appOf(input));
                reject(init.signal!.reason);
              },
              { once: true },
            );
          }),
      });
      const response = await routes.request("/widgets/v1");
      const reader = response.body!.getReader();
      await reader.read();
      await running.opened;
      await reader.cancel();
      await Bun.sleep(5);
      expect(aborted).toHaveLength(WIDGET_CONCURRENCY);
      expect(started).toBe(WIDGET_CONCURRENCY);
      // Leaving the dashboard is not a widget failure, so it leaves no warning that could hide a real one.
      expect(warnings).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("answers 503 without a stream when the invocation authority is unavailable", async () => {
    const routes = createWidgetRoutes({
      authenticate,
      listWidgets: async () => widgetsFor(2),
      withActiveSigner: async () => {
        throw new Error("signing keys unavailable");
      },
    });
    const response = await routes.request("/widgets/v1");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Widget invocation authority is currently unavailable" });
  });

  test("requires an OAuth read scope for the stream too", async () => {
    let registryCalls = 0;
    const routes = createWidgetRoutes({
      authenticate: async (c, next) => {
        c.set("actor", { kind: "user", user });
        c.set("accessSubject", { type: "user", userId: user.id });
        c.set("credentialKind", "oauth");
        c.set("credentialScopes", ["write"]);
        c.set("oauthScopes", ["write"]);
        await next();
      },
      listWidgets: async () => {
        registryCalls += 1;
        return widgetsFor(1);
      },
    });
    expect((await routes.request("/widgets/v1")).status).toBe(403);
    expect(registryCalls).toBe(0);
  });
});
