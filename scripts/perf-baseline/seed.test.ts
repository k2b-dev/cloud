import { expect, spyOn, test } from "bun:test";
import { serialize } from "seroval";
import { Runtime } from "./runtime";
import { Api, extractConsentVersion, noteContent, seed, waitForRoutes } from "./seed";

const legalVersion = "abcdef0123456789".repeat(4);
function consentHtml(version = legalVersion) {
  const props = serialize({ version, redirectTo: "/app/mail?example=one&other=two" });
  return `<solid-island data-id="consent" data-props="${props.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></solid-island>`;
}

test("consent version comes from decoded island props, ignoring document text and other attributes", async () => {
  const decoy = "0".repeat(64);
  const html = `<script>const version="${decoy}";</script><div data-props='({version:"${decoy}"})'>${decoy}</div>
    <solid-island data-id="other" data-props='({text:"${decoy}"})'></solid-island>${consentHtml()}`;
  expect(await extractConsentVersion(html)).toBe(legalVersion);
  expect(
    await extractConsentVersion(`<solid-client data-props='({redirectTo:"/", "version" : &#34;${legalVersion}&#34;})'></solid-client>`),
  ).toBe(legalVersion);
  expect(
    await extractConsentVersion(`<solid-island data-props='({version:"${legalVersion.replace("a", "\\u0061")}"})'></solid-island>`),
  ).toBe(legalVersion);
});

test("consent version fails closed on missing, invalid or ambiguous props", async () => {
  for (const html of [
    `<p>${legalVersion}</p>`,
    `<solid-island data-props='({version:123})'></solid-island>`,
    consentHtml("a".repeat(63)),
    consentHtml("g".repeat(64)),
    consentHtml(legalVersion.toUpperCase()),
    consentHtml() + consentHtml(),
  ])
    await expect(extractConsentVersion(html)).rejects.toThrow();
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
    { path: "/auth/continue", status: 302, message: "Admin consent page /auth/continue returned HTTP 302" },
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
