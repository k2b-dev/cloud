import { expect, setSystemTime, test } from "bun:test";
import { z } from "zod";
import { readCapabilityResponse } from "./response";

test("capability errors preserve valid numeric and HTTP-date Retry-After delays", async () => {
  setSystemTime(new Date("2040-06-01T12:00:00Z"));
  try {
    for (const retryAfter of ["90", "Fri, 01 Jun 2040 12:01:30 GMT"]) {
      const response = Response.json({ code: "RATE_LIMITED", message: "Busy" }, { status: 429, headers: { "Retry-After": retryAfter } });
      expect(await readCapabilityResponse(response, z.unknown())).toEqual({
        ok: false,
        error: { code: "RATE_LIMITED", message: "Busy", status: 429, retryAfterMs: 90_000 },
      });
    }
    for (const retryAfter of [undefined, "invalid", "-1", "99999999999999999999", "0"]) {
      const response = Response.json(
        { code: "RATE_LIMITED", message: "Busy" },
        { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} },
      );
      expect(await readCapabilityResponse(response, z.unknown())).toEqual({
        ok: false,
        error: { code: "RATE_LIMITED", message: "Busy", status: 429 },
      });
    }
  } finally {
    setSystemTime();
  }
});
