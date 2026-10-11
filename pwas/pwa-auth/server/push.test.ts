import { expect, test } from "bun:test";
import { NotifySchema } from "./push";

const notification = { token: "A".repeat(43), cloudOrigin: "https://cloud.example.test", requestRef: "request-1" };

test("the push wire accepts Action wake-ups and the original login body, but rejects unknown kinds", () => {
  expect(NotifySchema.parse(notification)).toEqual(notification);
  for (const kind of ["login", "action"] as const) expect(NotifySchema.parse({ ...notification, kind })).toEqual({ ...notification, kind });
  expect(NotifySchema.safeParse({ ...notification, kind: "unknown" }).success).toBe(false);
});
