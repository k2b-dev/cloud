import { expect, spyOn, test } from "bun:test";
import { secretRequestPorts } from "./secret-request-client";

const destination = { origin: "https://api.example.com", pathPrefix: "/v1", headers: ["authorization"] };
const metadata = { name: "API", binding_revision: "11111111-1111-4111-8111-111111111111", configured: true, ...destination };
const input = { name: "API", origin: destination.origin, header: "authorization", prefix: "" };
const privateValue = "fixture-private-header";

test("private browser transport routes chat writes to PUT and Code writes to the targeted capability without idempotency", async () => {
  const calls: { path: string; method: string; body: unknown; key: string | null }[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        calls.push({
          path: String(url),
          method: init?.method ?? "GET",
          body: JSON.parse(String(init?.body)),
          key: new Headers(init?.headers).get("idempotency-key"),
        });
        return String(url).endsWith("runtime/secrets")
          ? Response.json({
              name: "API",
              origin: input.origin,
              header: "authorization",
              prefix: "",
              revision: metadata.binding_revision,
              configured: true,
            })
          : Response.json({ data: { secret: metadata } });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    expect(await secretRequestPorts(input, "chat").save({ value: privateValue, revision: null, binding: destination })).toEqual({
      ok: true,
    });
    expect(
      await secretRequestPorts({ ...input, target: { code: "Abc234", pathPrefix: "/v1" } }, "chat").save({
        value: privateValue,
        revision: metadata.binding_revision,
      }),
    ).toEqual({ ok: true });
    expect(calls).toMatchObject([
      {
        path: "/api/assistant/chat-code/runtime/secrets",
        method: "PUT",
        body: { scope: { conversationId: "chat" }, secret: { name: "API", value: privateValue, expectedRevision: null } },
        key: null,
      },
      {
        path: "/api/capabilities/v1/actions/core/code.secret.set",
        method: "POST",
        body: {
          target: { type: "core.code", id: "Abc234" },
          input: { name: "API", value: privateValue, binding_revision: metadata.binding_revision },
        },
        key: null,
      },
    ]);
    expect(calls[1]?.body).not.toHaveProperty("input.binding");
  } finally {
    fetchSpy.mockRestore();
  }
});

test("metadata list follows pagination, resolves permitted names and never accepts a value response", async () => {
  const setter = "22222222-2222-4222-8222-222222222222";
  const paths: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        paths.push(String(url));
        if (String(url).endsWith("/core/code.read")) return Response.json({ data: { code: { title: "Shipping" } } });
        if (String(url).startsWith("/api/accounts/entities"))
          return Response.json({
            items: [{ kind: "user", user: { id: setter, displayName: "Lea Brandt", givenname: "Lea", sn: "Brandt", uid: "lea" } }],
          });
        const body = JSON.parse(String(init?.body));
        return Response.json({
          data: body.input.cursor
            ? { items: [{ ...metadata, value: privateValue, valueSetBy: setter, valueSetAt: "2026-11-03T12:00:00Z" }], nextCursor: null }
            : { items: [], nextCursor: "AAA" },
        });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const result = await secretRequestPorts({ ...input, target: { code: "Abc234", pathPrefix: "/v1" } }, "chat").list();
    expect(result).toMatchObject({ ok: true, title: "Shipping", entry: { valueSetBy: { name: "Lea Brandt" } } });
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(paths).toHaveLength(4);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("missing directory entries fall back to stored metadata without UUID as display name", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0]) =>
        Response.json(
          String(url).startsWith("/api/accounts/entities")
            ? { items: [] }
            : {
                data: { items: [{ ...metadata, valueSetBy: "22222222-2222-4222-8222-222222222222", valueSetAt: null }], nextCursor: null },
              },
        ),
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    expect(await secretRequestPorts({ ...input, target: { code: "Abc234", pathPrefix: "/v1" } }, "chat").list()).toMatchObject({
      ok: true,
      entry: { valueSetBy: null },
    });
  } finally {
    fetchSpy.mockRestore();
  }
});

test("metadata lookup follows database collation across full pages, including decreasing code points", async () => {
  const cursors: (string | undefined)[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(url).endsWith("/core/code.read")) return Response.json({ data: { code: { title: "Shipping" } } });
        const { input: query } = JSON.parse(String(init?.body));
        cursors.push(query.cursor);
        const names =
          query.cursor === undefined
            ? [...Array.from({ length: 19 }, (_, i) => `b${i + 10}`), "b5"]
            : query.cursor === "b5"
              ? ["C1", "C2", "C3"]
              : ["z9"];
        return Response.json({
          data: {
            items: names.map((name) => ({ ...metadata, name, valueSetAt: null, valueSetBy: null, value: privateValue })),
            nextCursor: query.cursor === undefined ? "b5" : query.cursor === "b5" ? "C3" : null,
          },
        });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const result = await secretRequestPorts({ ...input, name: "z9", target: { code: "Abc234", pathPrefix: "/v1" } }, "chat").list();
    expect(result).toMatchObject({ ok: true, entry: { revision: metadata.binding_revision } });
    expect(cursors).toEqual([undefined, "b5", "C3"]);
    expect(JSON.stringify(result)).not.toContain(privateValue);
  } finally {
    fetchSpy.mockRestore();
  }
});

for (const cycle of [
  ["b5", "b5"],
  ["b5", "C3", "b5"],
])
  test(`metadata lookup refuses repeated cursors ${cycle.join(" → ")}`, async () => {
    let requests = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => Response.json({ data: { items: [], nextCursor: cycle[requests++] } }), { preconnect: fetch.preconnect }),
    );
    try {
      expect(await secretRequestPorts({ ...input, target: { code: "Abc234", pathPrefix: "/v1" } }, "chat").list()).toEqual({
        ok: false,
        code: "INVALID_RESPONSE",
        status: null,
      });
      expect(requests).toBe(cycle.length);
    } finally {
      fetchSpy.mockRestore();
    }
  });

test("metadata lookup bounds pages and never reports absence after exhausting its budget", async () => {
  let requests = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => Response.json({ data: { items: [], nextCursor: `b${requests++}` } }), { preconnect: fetch.preconnect }),
  );
  try {
    expect(await secretRequestPorts({ ...input, target: { code: "Abc234", pathPrefix: "/v1" } }, "chat").list()).toEqual({
      ok: false,
      code: "INVALID_RESPONSE",
      status: null,
    });
    expect(requests).toBe(20);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("metadata lookup reports absence only after a null cursor, regardless of name order", async () => {
  const cursors: (string | undefined)[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(url).endsWith("/core/code.read")) return Response.json({ data: { code: { title: "Shipping" } } });
        const { input: query } = JSON.parse(String(init?.body));
        cursors.push(query.cursor);
        return Response.json({ data: { items: [], nextCursor: query.cursor === undefined ? "b5" : query.cursor === "b5" ? "C3" : null } });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    expect(await secretRequestPorts({ ...input, target: { code: "Abc234", pathPrefix: "/v1" } }, "chat").list()).toMatchObject({
      ok: true,
      entry: null,
    });
    expect(cursors).toEqual([undefined, "b5", "C3"]);
  } finally {
    fetchSpy.mockRestore();
  }
});

for (const code of ["FORBIDDEN", "NOT_FOUND"])
  test(`list propagates ${code} instead of an empty list`, async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ code, message: "Denied" }, { status: code === "NOT_FOUND" ? 404 : 403 }),
    );
    try {
      expect(await secretRequestPorts({ ...input, target: { code: "Abc234", pathPrefix: "/v1" } }, "chat").list()).toMatchObject({
        ok: false,
        code,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

test("a timed-out private capability write has an uncertain outcome without echoing the value", async () => {
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException(privateValue, "TimeoutError")));
  const request = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        init?.signal?.throwIfAborted();
        throw new Error("Expected a bounded private write");
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const result = await secretRequestPorts({ ...input, target: { code: "Abc234", pathPrefix: "/v1" } }, "chat").save({
      value: privateValue,
      revision: metadata.binding_revision,
    });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    request.mockRestore();
    timeout.mockRestore();
  }
});
