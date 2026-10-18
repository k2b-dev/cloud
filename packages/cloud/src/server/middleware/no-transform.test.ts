import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { middleware } from "./middleware";

describe("noTransform", () => {
  test.each([
    [undefined, "no-transform"],
    ["private, no-store", "private, no-store, no-transform"],
    ["private, No-Transform", "private, No-Transform"],
    ['private, extension="value,no-transform"', 'private, extension="value,no-transform", no-transform'],
  ])("merges %s without duplicating directives", async (value, expected) => {
    const app = new Hono()
      .use("*", middleware.noTransform())
      .use("*", middleware.noTransform())
      .get("/", (c) => {
        if (value) c.header("Cache-Control", value);
        return c.text("private");
      });
    expect((await app.request("/")).headers.get("Cache-Control")).toBe(expected);
  });

  test("marks errors, not found, redirects, and authentication failures", async () => {
    const app = new Hono()
      .use("*", middleware.noTransform())
      .onError((_, c) => c.text("failed", 500))
      .notFound((c) => c.text("missing", 404))
      .get("/error", () => {
        throw new Error("failure");
      })
      .get("/redirect", (c) => c.redirect("/login"))
      .get("/private", (c) => c.text("sign in", 401));
    for (const [path, status] of [
      ["/error", 500],
      ["/missing", 404],
      ["/redirect", 302],
      ["/private", 401],
    ] as const) {
      const response = await app.request(path);
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-transform");
    }
  });

  test("passes each chunk without waiting for the rest of the body", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(value) {
        controller = value;
      },
    });
    const app = new Hono().use("*", middleware.noTransform()).get("/", () => new Response(body));
    const response = await app.request("/");
    expect(response.body).toBe(body);
    expect(response.headers.get("Cache-Control")).toBe("no-transform");
    const reader = response.body!.getReader();
    for (const text of ["first", "second"]) {
      const chunk = new TextEncoder().encode(text);
      controller.enqueue(chunk);
      expect(await reader.read()).toEqual({ value: chunk, done: false });
    }
    controller.close();
    expect((await reader.read()).done).toBe(true);
  });

  test("copies immutable headers without buffering the body", async () => {
    // Bun currently exposes mutable fetch/redirect headers. Emulate the Fetch
    // immutable guard on the original Headers, leaving the copy mutable.
    let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(value) {
        controller = value;
      },
    });
    const original = new Response(body, { status: 201, headers: { "Cache-Control": "private, no-store", "X-Upstream": "kept" } });
    const immutable = spyOn(original.headers, "set").mockImplementation(() => {
      throw new TypeError("immutable");
    });
    try {
      const app = new Hono().use("*", middleware.noTransform()).get("/", () => original);
      const response = await app.request("/");
      expect(response.status).toBe(201);
      expect(response.headers.get("X-Upstream")).toBe("kept");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store, no-transform");
      expect(original.headers.get("Cache-Control")).toBe("private, no-store");
      expect(immutable).toHaveBeenCalledTimes(1);
      const reader = response.body!.getReader();
      for (const text of ["first", "second"]) {
        const chunk = new TextEncoder().encode(text);
        controller.enqueue(chunk);
        expect(await reader.read()).toEqual({ value: chunk, done: false });
      }
      controller.close();
      expect((await reader.read()).done).toBe(true);
    } finally {
      immutable.mockRestore();
    }
  });

  test("leaves WebSocket upgrades untouched", async () => {
    const upgrade = new Response(null, { status: 101 });
    const app = new Hono().use("*", middleware.noTransform()).get("/", () => upgrade);
    const response = await app.request("/");
    expect(response.status).toBe(101);
    expect(response.headers.get("Cache-Control")).toBeNull();
  });
});
