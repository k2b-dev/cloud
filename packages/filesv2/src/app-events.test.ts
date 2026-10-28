import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { filesCapabilities } from "./capabilities";
import { filesService } from "./service";

const subscription = filesCapabilities.subscribes["core.user.created"];
const eventId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const signal = new AbortController().signal;
const context = { eventId, subscriptionId: "filesv2:core.user.created@1", attempt: 1, signal };
const envelope = (provider: "local" | "ipa") => ({
  id: eventId,
  type: "core.user.created",
  version: 1,
  source: "core",
  time: "2026-01-01T00:00:00Z",
  subject: { type: "core.user", id: userId },
  data: { userId, provider },
});
const provision = spyOn(filesService, "provisionUserHome");
afterEach(() => provision.mockReset());
afterAll(() => provision.mockRestore());

test("user-created subscription uses declared version and forwards application delivery identity", async () => {
  provision.mockResolvedValue({
    userId,
    username: "alice",
    area: "cloud",
    state: "auto_create_off",
    operationId: null,
    eventId,
    errorCode: null,
    updatedAt: "2026-01-01T00:00:00Z",
  });
  expect(subscription.version).toBe(1);
  await subscription.run(envelope("local"), context);
  expect(provision).toHaveBeenCalledTimes(1);
  expect(provision).toHaveBeenCalledWith(userId, { eventId, signal });
});
test("FreeIPA user creation reaches the same service to persist its pending policy state", async () => {
  provision.mockResolvedValue({
    userId,
    username: "alice",
    area: "freeipa",
    state: "posix_incomplete",
    operationId: null,
    eventId,
    errorCode: null,
    updatedAt: "2026-01-01T00:00:00Z",
  });
  await subscription.run(envelope("ipa"), context);
  expect(provision).toHaveBeenCalledWith(userId, { eventId, signal });
});
test("subscriber refuses additional identity fields and propagates recoverable provisioning failures", async () => {
  expect(subscription.schema.safeParse({ userId, provider: "local", username: "untrusted" }).success).toBe(false);
  expect(subscription.schema.safeParse({ userId: "invalid", provider: "local" }).success).toBe(false);
  provision.mockRejectedValue(new Error("storage unavailable"));
  await expect(subscription.run(envelope("local"), context)).rejects.toThrow("storage unavailable");
});
