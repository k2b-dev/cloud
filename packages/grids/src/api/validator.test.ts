import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { v } from "./validator";

const InputSchema = z.object({ name: z.string() });

describe("Grids API validator", () => {
  test("returns one stable code with a request-localized message", async () => {
    const app = new Hono().post("/", v("json", InputSchema), (c) => c.json(c.req.valid("json")));
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
