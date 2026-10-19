import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { compileReviewFixture, reviewFixture } from "../_internal/capability-review.test-fixture";
import * as registry from "../_internal/registry";
import type { RuntimeAppMeta } from "../contracts/app";
import { ApprovalPageSchema } from "../contracts/approvals";
import { CapabilityActionReviewDataSchema } from "../contracts/capabilities";
import type { AuthContext } from "../server/middleware/auth";
import * as pending from "../services/approvals/list";
import * as logging from "../services/logging";
import { buildProjectedUser } from "../services/session/user";
import { loadPendingApprovals } from "./approvals-loader";

const user = buildProjectedUser({ id: "00000000-0000-4000-8000-000000000001", provider: "local", profile: "user" });
const row: pending.PendingApprovalRow = {
  id: "00000000-0000-4000-8000-000000000002",
  appId: "demo",
  action: "send",
  argsDigest: "original-digest",
  requesterAppId: "assistant",
  requesterTitle: "Send a letter",
  assurance: "standard",
  sentence: "Send a letter",
  details: reviewFixture(),
  storedReview: null,
  createdAt: new Date("2026-10-11T10:00:00Z"),
  expiresAt: new Date("2026-10-11T11:00:00Z"),
  cursorCreatedAt: "2026-10-11T10:00:00.000000Z",
  conversationShortId: "ab12345678",
  conversationTitle: "Send a letter",
  allowChat: true,
  allowAlways: true,
  rememberToolName: null,
  toolName: "demo.send",
  runConfig: { kind: "chat", input: "Send" },
};
const page = (items: pending.PendingApprovalRow[]) => ({ items, nextCursor: null, count: items.length, elsewhere: 0 });
const routes = new Hono<AuthContext & { Variables: { runtime: { apps: RuntimeAppMeta[] } } }>()
  .use(async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("runtime", { apps: [{ id: "demo", name: "Demo", icon: "ti ti-mail", description: "Demo", routes: ["/app/demo"] }] });
    await next();
  })
  .get("/", async (c) => c.json(await loadPendingApprovals(c, {})));

const restores: Array<{ mockRestore: () => void }> = [];
const warn = mock();
beforeEach(() => {
  warn.mockClear();
  restores.push(
    spyOn(pending, "listPending").mockResolvedValue(page([])),
    spyOn(registry, "listCapabilities").mockRejectedValue(new Error("Registry offline")),
    spyOn(logging, "logger").mockReturnValue({ debug: mock(), info: mock(), warn, error: mock() }),
  );
});
afterEach(() => {
  for (const spy of restores.splice(0)) spy.mockRestore();
});

const load = async () => {
  const response = await routes.request("/");
  expect(response.status).toBe(200);
  return ApprovalPageSchema.parse(await response.json());
};

test("an empty pending page does not read the capability registry", async () => {
  expect(await load()).toEqual({ items: [], nextCursor: null, count: 0, elsewhere: 0 });
  expect(registry.listCapabilities).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test("stored, explicit-reason and legacy reviews need no registry policy", async () => {
  const review = reviewFixture();
  for (const item of [
    { ...row, storedReview: { ...review, ask: "sensitive" as const } },
    { ...row, storedReview: review },
    { ...row, details: { ...review, ask: "sends" as const } },
    { ...row, details: { message: "Send it?" }, storedReview: { legacy: { question: "Send it?", rows: [] } } },
  ]) {
    spyOn(pending, "listPending").mockResolvedValue(page([item]));
    const result = await load();
    expect(result.items[0]?.review).toEqual(
      item.storedReview && "sentence" in item.storedReview ? item.storedReview : CapabilityActionReviewDataSchema.parse(item.details),
    );
  }
  expect(registry.listCapabilities).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test("a registry outage warns and preserves rows without a fallback policy", async () => {
  spyOn(pending, "listPending").mockResolvedValue(page([row]));
  const result = await load();
  expect(result).toMatchObject({ count: 1, elsewhere: 0, nextCursor: null });
  expect(result.items[0]).toMatchObject({ id: row.id, app: { name: "Demo" }, review: row.details });
  expect(registry.listCapabilities).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith("Approval capability registry unavailable", { error: "Registry offline" });
});

test("only reviews without a stored snapshot fall back to current manifest policy", async () => {
  const storedReview = { ...reviewFixture(), ask: "sensitive" as const };
  spyOn(pending, "listPending").mockResolvedValue(page([{ ...row, storedReview }, row]));
  spyOn(registry, "listCapabilities").mockResolvedValue([
    {
      appId: "demo",
      appName: "Demo",
      appIcon: "ti ti-mail",
      appDescription: "Demo",
      endpoint: "http://demo:3000",
      manifest: compileReviewFixture({ ask: "sends" }).manifest,
    },
  ]);
  const result = await load();
  expect(result.items.map((item) => item.review)).toEqual([storedReview, { ...reviewFixture(), ask: "sends" }]);
  expect(warn).not.toHaveBeenCalled();
});
