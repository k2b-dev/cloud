import { expect, spyOn, test } from "bun:test";
import { toJSON } from "seroval";
import { Runtime } from "./runtime";
import { Api, extractConsentVersion, noteContent, PhoneSession, pairPhone, removePhone, seed, waitForRoutes } from "./seed";

const legalVersion = "abcdef0123456789".repeat(4);
function consentHtml(version = legalVersion) {
  const props = JSON.stringify(toJSON({ version, redirectTo: "/app/mail?example=one&other=two" }));
  return `<solid-island data-id="consent" data-props="${props.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></solid-island>`;
}

const propsAttribute = (props: unknown) => Bun.escapeHTML(JSON.stringify(toJSON(props)));

test("consent version comes from decoded island props, ignoring document text and other attributes", async () => {
  const decoy = "0".repeat(64);
  const html = `<script>const version="${decoy}";</script><div data-props="${propsAttribute({ version: decoy })}">${decoy}</div>
    <solid-island data-id="other" data-props="${propsAttribute({ text: decoy })}"></solid-island>${consentHtml()}`;
  expect(await extractConsentVersion(html)).toBe(legalVersion);
  expect(
    await extractConsentVersion(
      `<solid-client data-props="${propsAttribute({ redirectTo: "/", version: legalVersion }).replaceAll("&quot;", "&#34;")}"></solid-client>`,
    ),
  ).toBe(legalVersion);
  expect(await extractConsentVersion(consentHtml().replace(legalVersion, legalVersion.replace("a", "\\u0061")))).toBe(legalVersion);
  expect(
    await extractConsentVersion(
      `<solid-island data-props="${propsAttribute(new Map([["version", decoy]]))}"></solid-island>${consentHtml()}`,
    ),
  ).toBe(legalVersion);
});

test("consent version fails closed on missing, invalid, unparsable or ambiguous props", async () => {
  for (const html of [
    `<p>${legalVersion}</p>`,
    `<solid-island data-props="${propsAttribute({ version: 123 })}"></solid-island>`,
    `<solid-island data-props="globalThis.pwned=1"></solid-island>${consentHtml()}`,
    `<solid-client data-props="("></solid-client>${consentHtml()}`,
    `<solid-island></solid-island>${consentHtml()}`,
    `<solid-island data-props="${propsAttribute({ nested: { version: legalVersion } })}"></solid-island>`,
    `<solid-island data-props="${propsAttribute(new Map([["version", legalVersion]]))}"></solid-island>`,
    consentHtml("a".repeat(63)),
    consentHtml("g".repeat(64)),
    consentHtml(legalVersion.toUpperCase()),
    consentHtml() + consentHtml(),
  ])
    await expect(extractConsentVersion(html)).rejects.toThrow();
  expect(Reflect.get(globalThis, "pwned")).toBeUndefined();
});

test("fresh admin login accepts public legal terms with Origin and proves authentication before returning", async () => {
  const origin = "https://localhost:4100";
  const requests: { path: string; method: string; headers: Headers; body: unknown; redirect: RequestRedirect | undefined }[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        requests.push({
          path,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          redirect: init?.redirect,
        });
        if (path === "/api/auth/admin-login") return Response.json({ session_token: "fixture-session", user: { id: "admin" } });
        if (path === "/auth/continue") return new Response(consentHtml());
        if (path === "/api/auth/legal-consent") return new Response(null, { status: 204 });
        if (path === "/api/me") return Response.json({ id: "admin" });
        throw new Error(`Unexpected request: ${path}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    const api = new Api(origin, new AbortController().signal);
    expect(await api.login("fixture-token")).toBe("admin");
    expect(requests.map(({ path, method }) => ({ path, method }))).toEqual([
      { path: "/api/auth/admin-login", method: "POST" },
      { path: "/auth/continue", method: "GET" },
      { path: "/api/auth/legal-consent", method: "POST" },
      { path: "/api/me", method: "GET" },
    ]);
    expect(requests[2]?.body).toEqual({ accepted: true, version: legalVersion });
    expect(requests[2]?.headers.get("Origin")).toBe(origin);
    expect(requests[2]?.headers.get("content-type")).toBe("application/json");
    for (const request of requests.slice(1)) {
      expect(request.headers.get("cookie")).toBe("session_token=fixture-session");
      expect(request.redirect).toBe("manual");
    }
  } finally {
    fetchSpy.mockRestore();
  }
});

test("login fails clearly if consent or the authenticated session is rejected", async () => {
  for (const failure of [
    { path: "/auth/continue", status: 503, message: "Admin consent page /auth/continue returned HTTP 503" },
    { path: "/api/auth/legal-consent", status: 200, message: "Admin legal consent returned HTTP 200; expected 204" },
    { path: "/api/auth/legal-consent", status: 403, message: "Admin legal consent returned HTTP 403; expected 204" },
    { path: "/api/me", status: 401, message: "Admin session verification GET /api/me after legal consent returned HTTP 401" },
  ]) {
    const paths: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: string | URL | Request) => {
          const path = new URL(String(input)).pathname;
          paths.push(path);
          if (path === failure.path) return new Response(null, { status: failure.status });
          if (path === "/api/auth/admin-login") return Response.json({ session_token: "fixture-session", user: { id: "admin" } });
          if (path === "/auth/continue") return new Response(consentHtml());
          if (path === "/api/auth/legal-consent") return new Response(null, { status: 204 });
          throw new Error(`Unexpected request: ${path}`);
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    try {
      const api = new Api("https://localhost:4100", new AbortController().signal);
      await expect(api.login("fixture-token")).rejects.toThrow(failure.message);
      expect(paths.at(-1)).toBe(failure.path);
    } finally {
      fetchSpy.mockRestore();
    }
  }
});

test("route readiness uses the session and retries login and consent redirects instead of accepting them", async () => {
  const signal = new AbortController().signal;
  const runtime = new Runtime(4100, "runtime", signal);
  const api = new Api(runtime.origin, signal);
  api.cookie = "fixture-session";
  const paths: string[] = [];
  const redirects = ["/auth/login?redirectTo=%2Fapp%2Fmail", "/auth/consent", "/auth/continue"];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        expect(new Headers(init?.headers).get("cookie")).toBe("session_token=fixture-session");
        expect(init?.redirect).toBe("manual");
        if (path === "/app/mail") {
          const location = redirects.shift();
          if (location) return new Response(null, { status: 302, headers: { location } });
        }
        return new Response("ready");
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    await waitForRoutes(api, ["core", "faq", "mail", "gateway"], runtime);
    expect(paths).toEqual(["/api/me", "/faq", "/app/mail", "/app/mail", "/app/mail", "/app/mail"]);
  } finally {
    fetchSpy.mockRestore();
  }
});

class FixtureApi extends Api {
  readonly requests: { path: string; method: string; input: unknown }[] = [];
  override async request(path: string, method = "GET", input?: unknown): Promise<unknown> {
    this.requests.push({ path, method, input });
    if (path === "/api/spaces") return { id: "space" };
    if (path === "/api/notebooks") return { id: "book" };
    if (path === "/api/notebooks/book/notes") return { id: "note" };
    if (path === "/api/ai/conversations") return { id: "chat" };
    if (path === "/api/filesv2/bases") return { items: [{ id: "cloud:users:admin", status: "existing" }] };
    if (path === "/api/mail/mailboxes") return { id: "mailbox" };
    return {};
  }
}

class FixtureRuntime extends Runtime {
  filegateStarted = false;
  readonly images: string[] = [];
  override async startFilegate() {
    this.filegateStarted = true;
  }
  override async container(_service: string, image: string) {
    this.images.push(image);
  }
}

test("deterministic public-API fixtures resolve real page paths without model calls or database writes", async () => {
  const signal = new AbortController().signal;
  const runtime = new FixtureRuntime(4100, "runtime", signal);
  const api = new FixtureApi(runtime.origin, signal);
  const pages = await seed(api, runtime, ["notebooks-editor", "assistant-chat", "files", "faq", "accounts"], "admin-id");
  expect(pages.map((page) => page.path)).toEqual([
    "/app/notebooks/book/notes/note?mode=write",
    "/app/assistant?conversation=chat",
    "/app/filesv2?base=cloud%3Ausers%3Aadmin",
    "/faq",
    "/app/accounts/users",
  ]);
  expect(pages.every((page) => page.status === "ok")).toBe(true);
  expect(api.requests.find((request) => request.path === "/api/notebooks/book/notes")?.input).toEqual({ contentMd: noteContent });
  expect(noteContent).toContain("```typescript");
  expect(api.requests.filter((request) => request.path === "/api/faq")).toHaveLength(3);
  expect(api.requests.some((request) => request.path.includes("/turns"))).toBe(false);
  expect(api.requests.find((request) => request.path.endsWith("linux-identities/configuration"))?.input).toMatchObject({
    rangeReserved: true,
    config: { enabled: true, rangeStart: 20_000, rangeEnd: 20_099 },
  });
  expect(api.requests.findIndex((request) => request.path.endsWith("linux-identities/users/admin-id"))).toBeLessThan(
    api.requests.findIndex((request) => request.path.endsWith("directories/create")),
  );
  expect(runtime.filegateStarted).toBe(true);
  expect(api.requests.filter((request) => request.path.endsWith("/markdown"))).toHaveLength(3);
});

test("Mail measures a real seeded mailbox without connecting a provider or starting a mail server", async () => {
  const signal = new AbortController().signal;
  const runtime = new FixtureRuntime(4100, "runtime", signal);
  const api = new FixtureApi(runtime.origin, signal);
  const pages = await seed(api, runtime, ["mail-mailbox", "assistant-chat"], "admin-id");
  expect(runtime.images).toEqual([]);
  expect(api.requests.filter((request) => request.path.startsWith("/api/mail"))).toEqual([
    {
      path: "/api/mail/mailboxes",
      method: "POST",
      input: { name: "Performance baseline mailbox", description: "Throwaway mailbox; never uses real credentials" },
    },
  ]);
  expect(pages[0]).toMatchObject({ path: "/app/mail/mailbox", status: "ok", errors: [], static: null, browsers: [] });
  expect(pages[0]?.notes[0]).toContain("without a provider connection: empty message list, smaller props, same eager JS");
  expect(pages[1]).toMatchObject({ path: "/app/assistant?conversation=chat", status: "ok" });
});

test("Space fixture uses the public starter API and its resolved page path", async () => {
  const signal = new AbortController().signal;
  const runtime = new FixtureRuntime(4100, "runtime", signal);
  const api = new FixtureApi(runtime.origin, signal);
  const pages = await seed(api, runtime, ["spaces"], "admin");
  expect(api.requests).toEqual([
    {
      path: "/api/spaces",
      method: "POST",
      input: {
        name: "Performance baseline space",
        description: "Deterministic production measurement fixture",
        starter: "tasks",
      },
    },
  ]);
  expect(pages[0]).toMatchObject({ path: "/app/spaces/space", status: "ok" });
});

type RecordedCall = { path: string; method: string; body: unknown; headers: Headers; redirect: RequestRedirect | undefined };
function mockFetch(reply: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const call: RecordedCall = {
          path: url.pathname + url.search,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
        };
        calls.push(call);
        return reply(call);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return { calls, restore: () => spy.mockRestore() };
}
const pairingId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const secret = "s".repeat(43);
const expiry = "2030-01-01T00:00:00.000Z";
function pairingReply(call: RecordedCall) {
  if (call.path === "/api/auth/pwa/v1/pairings")
    return Response.json({ id: pairingId, secret, claimUntil: expiry, expiresAt: expiry }, { status: 201 });
  if (call.path === "/pwa/_auth/pairings/claim")
    return Response.json(
      { code: "123456", account: { name: "Admin" }, expiresAt: expiry },
      { headers: { "set-cookie": "pwa_pairing=completion-secret; Path=/pwa/_auth/pairings; Secure; HttpOnly; SameSite=Strict" } },
    );
  if (call.path === `/api/auth/pwa/v1/pairings/${pairingId}/confirm`) return new Response(null, { status: 204 });
  if (call.path === "/pwa/_auth/pairings/complete") {
    const headers = new Headers();
    headers.append("set-cookie", "pwa_pairing=; Path=/pwa/_auth/pairings; Max-Age=0");
    headers.append("set-cookie", "pwa_session=app-session; Path=/; Secure; HttpOnly");
    headers.append("set-cookie", `pwa_device=${deviceId}.device-key; Path=/pwa/_auth; Secure; HttpOnly`);
    return Response.json({ state: "paired" }, { headers });
  }
  if (call.path === "/pwa/_auth/session" || call.path.startsWith("/api/auth/pwa/v1/devices/")) return new Response(null, { status: 204 });
  throw new Error(`Unexpected fixture request: ${call.path}`);
}

test("an existing administrator skips consent on Core's continue redirect and signs out through the public API", async () => {
  for (const consent of [new Response(null, { status: 302, headers: { location: "/" } }), new Response("<html>Nothing pending</html>")]) {
    const fetch = mockFetch(({ path }) => {
      if (path === "/api/auth/admin-login") return Response.json({ session_token: "web-session", user: { id: "admin" } });
      if (path === "/auth/continue") return consent;
      if (path === "/api/me") return Response.json({ id: "admin" });
      if (path === "/api/auth/logout") return Response.json({ message: "Logged out" });
      throw new Error(`Unexpected fixture request: ${path}`);
    });
    try {
      const api = new Api("https://example.test", new AbortController().signal);
      expect(await api.login("admin-token")).toBe("admin");
      await api.logout();
      expect(fetch.calls.map((call) => [call.method, call.path])).toEqual([
        ["POST", "/api/auth/admin-login"],
        ["GET", "/auth/continue"],
        ["GET", "/api/me"],
        ["POST", "/api/auth/logout"],
      ]);
      expect(fetch.calls[3]?.headers.get("cookie")).toBe("session_token=web-session");
      expect(api.cookie).toBe("");
    } finally {
      fetch.restore();
    }
  }
});

test("real phone pairing claims, confirms, completes and renames with independent path-scoped cookies", async () => {
  const fetch = mockFetch(pairingReply);
  const origin = "https://localhost:4100";
  const api = new Api(origin, new AbortController().signal);
  api.cookie = "web-session";
  try {
    const phone = await pairPhone(api, origin, api.signal, "perf-2026-10-14");
    expect(fetch.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", "/api/auth/pwa/v1/pairings", undefined],
      ["POST", "/pwa/_auth/pairings/claim", { secret, platform: "ios" }],
      ["POST", `/api/auth/pwa/v1/pairings/${pairingId}/confirm`, { code: "123456" }],
      ["POST", "/pwa/_auth/pairings/complete", undefined],
      ["PATCH", "/pwa/_auth/session", { name: "perf-2026-10-14" }],
    ]);
    for (const call of fetch.calls) {
      expect(call.headers.get("origin")).toBe(origin);
      expect(call.redirect).toBe("manual");
      if (call.path.startsWith("/api/")) expect(call.headers.get("cookie")).toBe("session_token=web-session");
      else {
        expect(call.headers.get("cookie") ?? "").not.toContain("session_token");
        expect(call.headers.get("accept-language")).toBe("en");
        expect(call.headers.get("user-agent")).toContain("iPhone");
      }
    }
    expect(fetch.calls[3]?.headers.get("cookie")).toBe("pwa_pairing=completion-secret");
    expect(fetch.calls[4]?.headers.get("cookie")).toBe(`pwa_session=app-session; pwa_device=${deviceId}.device-key`);
    expect(phone.deviceId).toBe(deviceId);
    expect(phone.browserCookies(origin)).toEqual([
      { name: "pwa_session", value: "app-session", path: "/", domain: "localhost", httpOnly: true, secure: true, sameSite: "Lax" },
      {
        name: "pwa_device",
        value: `${deviceId}.device-key`,
        path: "/pwa/_auth",
        domain: "localhost",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    await removePhone(api, phone.deviceId);
    expect(fetch.calls.at(-1)).toMatchObject({ method: "DELETE", path: `/api/auth/pwa/v1/devices/${deviceId}` });
    expect(fetch.calls.at(-1)?.headers.get("cookie")).toBe("session_token=web-session");
  } finally {
    fetch.restore();
  }
});

test("a waiting completion is polled and retains the claim cookie until paired", async () => {
  let completions = 0;
  const fetch = mockFetch((call) => {
    if (call.path === "/pwa/_auth/pairings/complete" && ++completions === 1)
      return Response.json({ state: "waiting", code: "123456", account: { name: "Admin" }, expiresAt: expiry }, { status: 202 });
    return pairingReply(call);
  });
  try {
    const api = new Api("https://example.test", new AbortController().signal);
    api.cookie = "web-session";
    await pairPhone(api, api.origin, api.signal, "perf-2026-10-14");
    expect(completions).toBe(2);
    expect(fetch.calls.filter((call) => call.path.endsWith("/complete")).map((call) => call.headers.get("cookie"))).toEqual([
      "pwa_pairing=completion-secret",
      "pwa_pairing=completion-secret",
    ]);
  } finally {
    fetch.restore();
  }
});

test("pairing errors identify the step and status without reflected codes, secrets, cookies or bodies", async () => {
  for (const [step, path] of [
    ["start", "/api/auth/pwa/v1/pairings"],
    ["claim", "/pwa/_auth/pairings/claim"],
    ["confirm", `/api/auth/pwa/v1/pairings/${pairingId}/confirm`],
    ["complete", "/pwa/_auth/pairings/complete"],
    ["rename", "/pwa/_auth/session"],
  ]) {
    const fetch = mockFetch((call) =>
      call.path === path ? Response.json({ secret, code: "123456", cookie: "device-key" }, { status: 403 }) : pairingReply(call),
    );
    try {
      const api = new Api("https://example.test", new AbortController().signal);
      api.cookie = "web-session";
      let message = "";
      try {
        await pairPhone(api, api.origin, api.signal, "perf-2026-10-14");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe(`Mobile app pairing: ${step} returned HTTP 403`);
      for (const value of [secret, "123456", "device-key", "web-session"]) expect(message).not.toContain(value);
      if (step === "rename") expect(fetch.calls.at(-1)?.path).toBe(`/api/auth/pwa/v1/devices/${deviceId}`);
    } finally {
      fetch.restore();
    }
  }
});

test("pairing validation does not expose invalid successful response data", async () => {
  const fetch = mockFetch(() => Response.json({ id: pairingId, secret: "reflected-invalid-secret" }, { status: 201 }));
  try {
    const api = new Api("https://example.test", new AbortController().signal);
    await expect(pairPhone(api, api.origin, api.signal, "perf-2026-10-14")).rejects.toThrow("Mobile app pairing: start returned HTTP 201");
  } finally {
    fetch.restore();
  }
});

test("phone cookies honor paths and deletion, and browser renewal replaces both credentials", async () => {
  const headers = new Headers();
  headers.append("set-cookie", "pwa_pairing=claim; Path=/pwa/_auth/pairings");
  headers.append("set-cookie", "pwa_device=old.key; Path=/pwa/_auth");
  headers.append("set-cookie", "pwa_session=app; Path=/");
  headers.append("set-cookie", "session_token=must-not-reach-phone; Path=/");
  const fetch = mockFetch((call) => {
    if (call.path.endsWith("/claim")) return new Response(null, { status: 204, headers });
    if (call.path === "/delete") {
      const headers = new Headers();
      headers.append("set-cookie", "pwa_pairing=gone; Path=/pwa/_auth/pairings; Max-Age=0");
      headers.append("set-cookie", "pwa_session=gone; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
      return new Response(null, { status: 204, headers });
    }
    return new Response(null, { status: 204 });
  });
  try {
    const phone = new PhoneSession("https://example.test", new AbortController().signal);
    await phone.response("/pwa/_auth/pairings/claim");
    await phone.response("/pwa/_auth/pairings/complete");
    await phone.response("/pwa/_auth/session", "PATCH", { name: "test" });
    await phone.response("/pwa/_authentic");
    expect(fetch.calls[1]?.headers.get("cookie")).toBe("pwa_pairing=claim; pwa_device=old.key; pwa_session=app");
    expect(fetch.calls[2]?.headers.get("cookie")).toBe("pwa_device=old.key; pwa_session=app");
    expect(fetch.calls[3]?.headers.get("cookie")).toBe("pwa_session=app");
    await phone.response("/delete");
    await phone.response("/pwa/_auth/pairings/complete");
    expect(fetch.calls.at(-1)?.headers.get("cookie")).toBe("pwa_device=old.key");
    phone.takeBrowserCookies([
      {
        name: "pwa_device",
        value: `${deviceId}.rotated`,
        path: "/pwa/_auth",
        domain: "example.test",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
      {
        name: "pwa_session",
        value: "rotated-session",
        path: "/",
        domain: "example.test",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
      {
        name: "session_token",
        value: "web-forbidden",
        path: "/",
        domain: "example.test",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    expect(phone.deviceId).toBe(deviceId);
    expect(phone.browserCookies(phone.origin).map((cookie) => cookie.value)).toEqual([`${deviceId}.rotated`, "rotated-session"]);
    await phone.response("/pwa/_auth/session");
    expect(fetch.calls.at(-1)?.headers.get("cookie")).toBe(`pwa_device=${deviceId}.rotated; pwa_session=rotated-session`);
  } finally {
    fetch.restore();
  }
});

test("PWA seeding creates 12 open assigned tasks and verifies the mine overview", async () => {
  class PwaFixtureApi extends Api {
    readonly calls: { path: string; method: string; input: unknown }[] = [];
    readonly ids: string[] = [];
    visible = 12;
    override async request(path: string, method = "GET", input?: unknown): Promise<unknown> {
      this.calls.push({ path, method, input });
      if (path === "/api/spaces") return { id: "space" };
      if (path === "/api/spaces/space/columns") return { id: "column" };
      if (path === "/api/spaces/space/items") {
        const id = `task${this.ids.length}`;
        this.ids.push(id);
        return { id };
      }
      if (path === "/api/spaces/overview/work?view=mine")
        return { view: "mine", items: this.ids.slice(0, this.visible).map((shortId) => ({ shortId })) };
      throw new Error(`Unexpected fixture request: ${path}`);
    }
  }
  const signal = new AbortController().signal;
  const runtime = new FixtureRuntime(4100, "runtime", signal);
  for (const visible of [12, 11]) {
    const api = new PwaFixtureApi(runtime.origin, signal);
    api.visible = visible;
    const pages = await seed(api, runtime, ["pwa"], "admin");
    expect(pages[0]?.status).toBe(visible === 12 ? "ok" : "failed");
    const tasks = api.calls.filter((call) => call.path.endsWith("/items"));
    expect(tasks).toHaveLength(12);
    expect(tasks[0]?.input).toEqual({ columnId: "column", title: "Perf task 01", assigneeIds: ["admin"] });
    expect(tasks[11]?.input).toEqual({ columnId: "column", title: "Perf task 12", assigneeIds: ["admin"] });
    if (visible === 12) expect(pages[0]?.notes.join(" ")).toContain("12 open tasks");
    else expect(pages[0]?.errors.join(" ")).toContain("mine overview");
  }
});

test("readiness checks the public PWA manifest and authenticated Spaces route", async () => {
  const signal = new AbortController().signal;
  const runtime = new Runtime(4100, "runtime", signal);
  const api = new Api(runtime.origin, signal);
  api.cookie = "web-session";
  const fetch = mockFetch(() => new Response("ready"));
  try {
    await waitForRoutes(api, ["pwa", "spaces"], runtime);
    expect(fetch.calls.map((call) => [call.path, call.headers.get("cookie")])).toEqual([
      ["/pwa/manifest.webmanifest", null],
      ["/app/spaces", "session_token=web-session"],
    ]);
  } finally {
    fetch.restore();
  }
});

test("remote login refuses pending consent without changing legal acceptance", async () => {
  const fetch = mockFetch(({ path }) => {
    if (path === "/api/auth/admin-login") return Response.json({ session_token: "web-session", user: { id: "admin" } });
    if (path === "/auth/continue") return new Response(consentHtml());
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  try {
    const api = new Api("https://example.test", new AbortController().signal);
    await expect(api.login("admin-token", false)).rejects.toThrow("accept the terms before using --origin");
    expect(fetch.calls.map((call) => call.path)).toEqual(["/api/auth/admin-login", "/auth/continue"]);
    expect(api.cookie).toBe("web-session");
  } finally {
    fetch.restore();
  }
});

test("waiting phone pairing responds to cancellation without another completion request", async () => {
  const controller = new AbortController();
  const fetch = mockFetch((call) => {
    if (call.path === "/pwa/_auth/pairings/complete") {
      controller.abort(new Error("pairing interrupted"));
      return Response.json({ state: "waiting", code: "123456", account: { name: "Admin" }, expiresAt: expiry }, { status: 202 });
    }
    return pairingReply(call);
  });
  try {
    const api = new Api("https://example.test", controller.signal);
    await expect(pairPhone(api, api.origin, controller.signal, "perf-2026-10-14")).rejects.toThrow();
    expect(fetch.calls.filter((call) => call.path.endsWith("/complete"))).toHaveLength(1);
  } finally {
    fetch.restore();
  }
});
