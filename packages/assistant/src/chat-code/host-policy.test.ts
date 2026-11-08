import { expect, test } from "bun:test";
import { backgroundChatCodeRouteAllowed as allowed } from "./host-policy";

test("background runner admits fixed services and denies interactive secrets and approval continuation routes", () => {
  for (const path of [
    "/runtime/views",
    "/runtime/ai",
    "/runtime/pdf",
    "/runtime/capabilities",
    "/runtime/http",
    "/runtime/secrets/list",
    "/runtime/http/00000000-0000-4000-8000-000000000001",
  ])
    expect(allowed(path, "POST")).toBe(true);
  expect(allowed("/runtime/chunks/csv", "GET")).toBe(true);
  for (const path of [
    "/runtime/secrets",
    "/runtime/secrets/remove",
    "/runtime/client-calls/claim",
    "/runtime/client-calls/complete",
    "/runtime/capabilities/00000000-0000-4000-8000-000000000001/resolve",
    "/runtime/capabilities/00000000-0000-4000-8000-000000000001/stream",
    "/runtime/check/start",
    "/runtime/chunks/not-a-library",
  ])
    for (const method of ["GET", "PUT", "POST", "DELETE"]) expect(allowed(path, method)).toBe(false);
});
