import { afterEach, expect, spyOn, test } from "bun:test";
import type { Context } from "hono";
import { auth } from "../server/middleware/auth";
import * as approvals from "../services/approvals/list";
import { ADMIN_STATUS_BUDGET_MS, preloadAdminCodeApprovals } from "./admin-status";

const authority = { actor: { kind: "user" }, accessSubject: { type: "user", userId: "u1" }, credentialKind: "session", scopes: [] };
const fakeContext = (path: string, roles: string[]) => {
  const values = new Map<string, unknown>([["user", { id: "u1", roles }]]);
  const context = { req: { path }, get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) };
  return { c: context as unknown as Context, values };
};
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
const spies: { mockRestore(): void }[] = [];

test("admins on admin pages get the exact Code-version count within the hint budget", async () => {
  spies.push(spyOn(auth, "getAuthority").mockReturnValue(authority as never));
  const count = spyOn(approvals, "countPending").mockResolvedValue({ total: 3, apps: { core: 3 } });
  spies.push(count);
  const { c, values } = fakeContext("/admin/code", ["admin"]);
  await preloadAdminCodeApprovals(c);
  expect(values.get("adminCodeApprovals")).toBe(3);
  expect(count).toHaveBeenCalledWith(
    expect.objectContaining({ approverUserId: "u1", kind: "code_version", timeoutMs: ADMIN_STATUS_BUDGET_MS }),
  );
});

test("other people, other pages and failed or cancelled reads leave the count out", async () => {
  spies.push(spyOn(auth, "getAuthority").mockReturnValue(authority as never));
  const count = spyOn(approvals, "countPending").mockRejectedValue(new Error("canceling statement due to statement timeout"));
  spies.push(count);
  for (const [path, roles] of [
    ["/admin/code", ["user"]],
    ["/app/mail", ["admin"]],
    ["/admin", ["admin"]],
  ] as const) {
    const { c, values } = fakeContext(path, [...roles]);
    await preloadAdminCodeApprovals(c);
    expect(values.has("adminCodeApprovals")).toBe(false);
  }
  expect(count).toHaveBeenCalledTimes(1);
});

test("the hint never fails a page and reads nothing outside Administration", async () => {
  const count = spyOn(approvals, "countPending").mockResolvedValue({ total: 1, apps: {} });
  spies.push(count);
  const values = new Map<string, unknown>([["user", { id: "u1" }]]);
  const page = (path: string) =>
    ({
      req: { path },
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value),
    }) as unknown as Context;
  // A user without roles makes the role check throw; it stays inside the hint.
  await preloadAdminCodeApprovals(page("/admin/code"));
  await preloadAdminCodeApprovals(page("/app/mail"));
  expect(values.has("adminCodeApprovals")).toBe(false);
  expect(count).not.toHaveBeenCalled();
});
