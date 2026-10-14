import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { REQUEST_IDLE_TIMEOUT_MAX_SECONDS, REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "./request-timeout";

describe("request idle timeout", () => {
  test("the maximum stays below Bun.serve's 255-second idle timeout limit", () => {
    expect(REQUEST_IDLE_TIMEOUT_MAX_SECONDS).toBeLessThan(255);
  });

  test("a raised timeout lets a slow handler answer while the default closes its connection", async () => {
    const app = new Hono()
      .get("/raised", async (c) => {
        setRequestTimeout(c, 30);
        await Bun.sleep(13_000);
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
        return c.text("slow answer");
      })
      .get("/control", async (c) => {
        await Bun.sleep(13_000);
        return c.text("too late");
      });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const [raised, control] = await Promise.allSettled([
        fetch(new URL("/raised", server.url), { signal: AbortSignal.timeout(25_000) }).then(async (response) => ({
          status: response.status,
          text: await response.text(),
        })),
        fetch(new URL("/control", server.url), { signal: AbortSignal.timeout(25_000) }),
      ]);
      expect(raised).toEqual({ status: "fulfilled", value: { status: 200, text: "slow answer" } });
      // Bun closes the idle connection before the control answers.
      expect(control.status).toBe("rejected");
      if (control.status === "rejected") expect(String(control.reason)).toContain("socket connection was closed");
    } finally {
      await server.stop(true);
    }
  }, 30_000);

  test.each([0, -1, 1.5, NaN, Infinity, REQUEST_IDLE_TIMEOUT_MAX_SECONDS + 1])("rejects an invalid timeout: %s", async (seconds) => {
    const app = new Hono();
    app.onError((error, c) => {
      expect(error).toBeInstanceOf(RangeError);
      return c.text("invalid timeout", 400);
    });
    app.get("/", (c) => {
      setRequestTimeout(c, seconds);
      return c.text("unexpected");
    });
    expect((await app.request("/")).status).toBe(400);
  });

  test("is a no-op without a Bun server", async () => {
    const app = new Hono().get("/", (c) => {
      setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_MAX_SECONDS);
      setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
      return c.text("ok");
    });
    for (const env of [undefined, {}, { timeout: 30 }]) {
      const response = await app.request("/", {}, env);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    }
  });
});
