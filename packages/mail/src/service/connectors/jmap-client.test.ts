import { afterEach, expect, test } from "bun:test";
import {
  callJmap,
  fetchJmapSession,
  JMAP_CORE,
  JMAP_MAIL,
  jmapBasicAuthorization,
  probeJmap,
  requireJmapMethodResult,
  validateJmapId,
} from "./jmap-client";
import { createJmapFixture } from "./jmap-fixture";

const fixtures: ReturnType<typeof createJmapFixture>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});
const fixture = () => {
  const value = createJmapFixture();
  fixtures.push(value);
  return value;
};
const signal = () => new AbortController().signal;
const access = (f: ReturnType<typeof fixture>) => ({
  origin: f.origin,
  authorization: jmapBasicAuthorization("reader", { kind: "password", password: "fixture-only" }),
  signal: signal(),
});

for (const status of [200, 401, 301, 302, 307, 308, 403, 404, 429, 500]) {
  test(`credential-free probe handles HTTP ${status}`, async () => {
    const f = fixture();
    f.controls.status = status;
    expect(await probeJmap("mail.example.invalid", signal(), f.dependencies)).toBe(status === 401 ? "detected" : "absent");
    expect(f.requests).toHaveLength([301, 302, 307, 308].includes(status) ? 2 : 1);
    expect(f.requests.every((request) => request.authorization === null)).toBe(true);
    expect(f.requests[0]!.path).toBe("/.well-known/jmap");
  });
}

test("probe rejects malformed JSON, cross-origin redirects, failures and cancellation", async () => {
  const f = fixture();
  f.controls.handle = () => new Response("not json");
  expect(await probeJmap("mail.example.invalid", signal(), f.dependencies)).toBe("absent");
  f.controls.handle = undefined;
  f.controls.redirect = "https://other.example.invalid/session";
  expect(await probeJmap("mail.example.invalid", signal(), f.dependencies)).toBe("absent");
  const controller = new AbortController();
  controller.abort();
  expect(await probeJmap("mail.example.invalid", controller.signal, f.dependencies)).toBe("unknown");
  f.controls.abort = true;
  expect(await probeJmap("mail.example.invalid", signal(), f.dependencies)).toBe("unknown");
});

test("probe only accepts a hostname at port 443", async () => {
  const f = fixture();
  for (const host of [
    "mail.example.invalid:443",
    "mail.example.invalid:8443",
    "reader@mail.example.invalid",
    "mail.example.invalid/path",
    "mail.example.invalid?query",
  ]) {
    expect(await probeJmap(host, signal(), f.dependencies)).toBe("unknown");
  }
  expect(f.requests).toHaveLength(0);
});

test("probe follows one redirect and inspects its result without credentials", async () => {
  const f = fixture();
  expect(await probeJmap("mail.example.invalid", signal(), f.dependencies)).toBe("detected");
  f.controls.redirect = "/jmap/session";
  expect(await probeJmap("mail.example.invalid", signal(), f.dependencies)).toBe("detected");
  f.controls.handle = (req) => (new URL(req.url).pathname === "/jmap/session" ? new Response("Sign in", { status: 401 }) : undefined);
  expect(await probeJmap("mail.example.invalid", signal(), f.dependencies)).toBe("detected");
  f.controls.handle = (req) => (new URL(req.url).pathname === "/jmap/session" ? new Response("<html>Webmail</html>") : undefined);
  expect(await probeJmap("mail.example.invalid", signal(), f.dependencies)).toBe("absent");
  expect(f.requests.every((request) => request.authorization === null)).toBe(true);
});

test("probe reports budget exhaustion and blocked endpoints as unknown", async () => {
  const f = fixture();
  f.controls.oversized = true;
  expect(await probeJmap("mail.example.invalid", signal(), f.dependencies)).toBe("unknown");
  expect(await probeJmap("127.0.0.1", signal())).toBe("unknown");
});

test("one relative redirect and relative session templates preserve origin and placeholders", async () => {
  const f = fixture();
  f.controls.redirect = "/jmap/session";
  f.session.apiUrl = "./";
  const session = await fetchJmapSession(access(f), f.dependencies);
  expect(session.apiUrl).toBe(`${f.origin}/jmap/`);
  expect(session.downloadUrl).toBe(`${f.origin}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`);
  expect(session.uploadUrl).toBe(`${f.origin}/jmap/upload/{accountId}/`);
  expect(session.eventSourceUrl).toBe(`${f.origin}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`);
  expect(f.requests.map((req) => req.path)).toEqual(["/.well-known/jmap", "/jmap/session"]);
  expect(f.requests.every((req) => req.authorization === access(f).authorization)).toBe(true);
});

for (const [kind, location] of [
  ["host", "https://other.example.invalid/session"],
  ["scheme", "http://mail.example.invalid/session"],
  ["port", "https://mail.example.invalid:8443/session"],
  ["userinfo", "https://reader:fixture@mail.example.invalid/session"],
] as const) {
  test(`rejects unauthorized redirect ${kind}`, async () => {
    const f = fixture();
    f.controls.redirect = location;
    await expect(fetchJmapSession(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_REDIRECT" });
    expect(f.requests).toHaveLength(1);
  });
}

test("rejects a second redirect", async () => {
  const f = fixture();
  f.controls.status = 307;
  await expect(fetchJmapSession(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_REDIRECT" });
  expect(f.requests).toHaveLength(2);
});

for (const field of ["apiUrl", "downloadUrl", "uploadUrl", "eventSourceUrl"] as const) {
  test(`validates the origin of ${field}`, async () => {
    const f = fixture();
    f.session[field] = "//other.example.invalid/";
    await expect(fetchJmapSession(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_ORIGIN" });
    expect(f.requests).toHaveLength(1);
  });
}

test("validates session shape, account IDs and local session byte budget", async () => {
  const f = fixture();
  f.controls.handle = () => Response.json({});
  await expect(fetchJmapSession(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  f.controls.handle = () => Response.json({ ...f.session, accounts: { "bad/id": f.session.accounts.d333333 } });
  await expect(fetchJmapSession(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  f.controls.handle = undefined;
  f.controls.oversized = true;
  await expect(fetchJmapSession(access(f), f.dependencies)).rejects.toMatchObject({ code: "JMAP_TOO_LARGE" });
});

test("validates RFC 8620 IDs without returning untrusted input in errors", () => {
  for (const id of ["d333333", "a", "eaaaaab", "A_z-9", "a".repeat(255)]) expect(validateJmapId(id)).toBe(id);
  for (const id of ["", "a".repeat(256), "../a", "a b", "é", 1, null]) expect(() => validateJmapId(id)).toThrow("JMAP_INVALID_ID");
});

test("encodes password credentials using Basic", () => {
  expect(jmapBasicAuthorization("reader", { kind: "password", password: "fixture" })).toBe(
    `Basic ${Buffer.from("reader:fixture").toString("base64")}`,
  );
  expect(() => jmapBasicAuthorization("bad:name", { kind: "password", password: "fixture" })).toThrow("JMAP_ACCOUNT");
});

test("separates rate limits, request errors, method errors, HTTP failures and transport aborts", async () => {
  const f = fixture();
  const auth = access(f);
  const session = await fetchJmapSession(auth, f.dependencies);
  const call = () =>
    callJmap(
      { ...auth, session, using: [JMAP_CORE, JMAP_MAIL], methodCalls: [["Mailbox/get", { accountId: "d333333", ids: [] }, "call"]] },
      f.dependencies,
    ).then((response) => requireJmapMethodResult(response, "call", "Mailbox/get"));
  f.controls.apiStatus = 429;
  await expect(call()).rejects.toMatchObject({ code: "JMAP_RATE_LIMIT", retryAfter: "30" });
  f.controls.apiStatus = 400;
  await expect(call()).rejects.toMatchObject({ code: "JMAP_REQUEST", problemType: "urn:ietf:params:jmap:error:limit" });
  f.controls.apiStatus = null;
  f.controls.methodError = "forbidden";
  await expect(call()).rejects.toMatchObject({ code: "JMAP_METHOD", methodType: "forbidden" });
  f.controls.methodError = null;
  f.controls.status = 401;
  await expect(call()).rejects.toMatchObject({ code: "JMAP_HTTP", status: 401 });
  f.controls.status = null;
  f.controls.abort = true;
  await expect(call()).rejects.toMatchObject({ code: "JMAP_TRANSPORT" });
  const controller = new AbortController();
  controller.abort();
  await expect(callJmap({ ...auth, signal: controller.signal, session, using: [], methodCalls: [] }, f.dependencies)).rejects.toMatchObject(
    { code: "JMAP_ABORTED" },
  );
});

test("checks request limits before sending and validates response envelopes", async () => {
  const f = fixture();
  const auth = access(f);
  const session = await fetchJmapSession(auth, f.dependencies);
  session.core.maxCallsInRequest = 1;
  const call = (methodCalls: [string, Record<string, unknown>, string][]) =>
    callJmap({ ...auth, session, using: [JMAP_CORE], methodCalls }, f.dependencies);
  await expect(
    call([
      ["Mailbox/get", {}, "a"],
      ["Mailbox/get", {}, "b"],
    ]),
  ).rejects.toMatchObject({ code: "JMAP_CALL_LIMIT" });
  session.core.maxSizeRequest = 1;
  await expect(call([])).rejects.toMatchObject({ code: "JMAP_REQUEST_LIMIT" });
  expect(f.requests).toHaveLength(1);
  session.core.maxSizeRequest = 10_000;
  f.controls.handle = () => Response.json({ methodResponses: [] });
  await expect(call([])).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  f.controls.handle = () => new Response(null, { status: 307, headers: { location: "/elsewhere" } });
  await expect(call([])).rejects.toMatchObject({ code: "JMAP_REDIRECT" });
});

test("probe accepts normalized international hostnames without changing the port", async () => {
  const f = fixture();
  expect(await probeJmap("münchen.example.invalid", signal(), f.dependencies)).toBe("detected");
  expect(f.requests[0]!.authorization).toBeNull();
});

test("correlates mixed success and method errors independently of response order", async () => {
  const f = fixture();
  const auth = access(f);
  const session = await fetchJmapSession(auth, f.dependencies);
  f.methodErrors.set("changes", "cannotCalculateChanges");
  f.methodErrors.set("dependent", "invalidResultReference");
  const response = await callJmap(
    {
      ...auth,
      session,
      using: [JMAP_CORE, JMAP_MAIL],
      methodCalls: [
        ["Email/changes", {}, "changes"],
        ["Email/get", {}, "dependent"],
        ["Mailbox/get", { ids: [] }, "success"],
      ],
    },
    f.dependencies,
  );
  response.methodResponses.reverse();
  expect(response.methodResponses).toContainEqual(["error", { type: "cannotCalculateChanges" }, "changes"]);
  expect(response.methodResponses).toContainEqual(["error", { type: "invalidResultReference" }, "dependent"]);
  expect(requireJmapMethodResult(response, "success", "Mailbox/get")).toMatchObject({ list: [] });
  expect(() => requireJmapMethodResult(response, "changes", "Email/changes")).toThrow("JMAP method rejected");
  expect(() => requireJmapMethodResult(response, "missing", "Mailbox/get")).toThrow("JMAP_INVALID_RESPONSE");
});

for (const result of [
  [],
  [["Mailbox/get", {}, "other"]],
  [["Email/get", {}, "call"]],
  [["error", {}, "call"]],
  [
    ["Mailbox/get", {}, "call"],
    ["Mailbox/get", {}, "call"],
  ],
]) {
  test(`rejects uncorrelated method response ${JSON.stringify(result)}`, async () => {
    const f = fixture();
    const auth = access(f);
    const session = await fetchJmapSession(auth, f.dependencies);
    f.controls.handle = () => Response.json({ methodResponses: result, sessionState: "s" });
    await expect(
      callJmap({ ...auth, session, using: [JMAP_CORE], methodCalls: [["Mailbox/get", { ids: [] }, "call"]] }, f.dependencies),
    ).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  });
}

test("rejects duplicate request call IDs before sending", async () => {
  const f = fixture();
  const auth = access(f);
  const session = await fetchJmapSession(auth, f.dependencies);
  await expect(
    callJmap(
      {
        ...auth,
        session,
        using: [JMAP_CORE],
        methodCalls: [
          ["Mailbox/get", {}, "same"],
          ["Mailbox/get", {}, "same"],
        ],
      },
      f.dependencies,
    ),
  ).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
  expect(f.requests).toHaveLength(1);
});
