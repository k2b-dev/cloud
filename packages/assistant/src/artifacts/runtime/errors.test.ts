import { expect, test } from "bun:test";
import { z } from "zod";
import { createDownload } from "./download";
import { cloudError } from "./errors";

test("one error mapping preserves messages and covers transport codes", () => {
  for (const [code, expected] of [
    ["ACCESS_DENIED", "denied"],
    ["HTTP_DENIED", "denied"],
    ["NOT_FOUND", "not_found"],
    ["DB_LIMIT", "limit"],
    ["INVALID_INPUT", "invalid"],
    ["HTTP_CONFLICT", "conflict"],
    ["DB_UNREACHABLE", "unavailable"],
    ["DB_CANCELLED", "cancelled"],
  ]) {
    const error = cloudError({ code, message: "Please try a smaller batch." });
    expect(error.name).toBe("CloudError");
    expect(String(error.code)).toBe(expected!);
    expect(error.message).toBe("Please try a smaller batch.");
  }
  expect(cloudError(new DOMException("Stopped", "AbortError")).code).toBe("cancelled");
  expect(cloudError(new Error("Unexpected failure")).code).toBe("unavailable");
});
test("an unconfigured database maps to unavailable even with a 409 transport status", () => {
  expect(cloudError({ code: "DB_NOT_CONFIGURED", status: 409, message: "The app database service is not configured." })).toMatchObject({
    name: "CloudError",
    code: "unavailable",
    message: "The app database service is not configured.",
  });
});
test("download rejects a Promise before crossing the bridge", async () => {
  let called = false;
  const download = createDownload(async () => {
    called = true;
  });
  await expect(download("report.csv", Promise.resolve("data"))).rejects.toMatchObject({ name: "CloudError", code: "invalid" });
  await expect(download("report.csv", Promise.resolve("data"))).rejects.toThrow("await cloud.sheet.toCsv");
  expect(called).toBe(false);
});

test("validation errors name the argument in one readable sentence", () => {
  const parsed = z.object({ name: z.string() }).safeParse({ name: 42 });
  if (parsed.success) throw new Error("Invalid fixture");
  expect(cloudError(parsed.error)).toMatchObject({
    name: "CloudError",
    code: "invalid",
    message: 'Invalid argument "name": Invalid input: expected string, received number.',
  });
});

test("a disconnected database is unavailable despite its 409 status", () => {
  expect(cloudError({ code: "DB_NOT_CONNECTED", status: 409, message: "Not connected" })).toMatchObject({
    code: "unavailable",
    message: "Not connected",
  });
});
