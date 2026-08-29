import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { v } from "./validator";

const InputSchema = z.object({ name: z.string() });

describe("validator", () => {
  test("preserves the detailed default response", async () => {
    const app = new Hono().post("/", v("json", InputSchema), (c) => c.json(c.req.valid("json")));

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { message: string }).toEqual({
      message: "name: Invalid input: expected string, received number",
    });
  });

  test("resolves an application-owned error for each request", async () => {
    const app = new Hono().post(
      "/",
      v("json", InputSchema, (c) => ({
        code: "VALIDATION_FAILED",
        message: c.req.header("x-cloud-locale")?.startsWith("de") ? "Die Anfrage ist ungültig." : "The request is invalid.",
      })),
      (c) => c.json(c.req.valid("json")),
    );
    const request = (locale: string) =>
      app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cloud-locale": locale },
        body: JSON.stringify({ name: 42 }),
      });

    const [english, german] = await Promise.all([request("en"), request("de-CH")]);

    expect(await english.json()).toEqual({ code: "VALIDATION_FAILED", message: "The request is invalid." });
    expect(await german.json()).toEqual({ code: "VALIDATION_FAILED", message: "Die Anfrage ist ungültig." });
  });
});
