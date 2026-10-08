import { describe, expect, test } from "bun:test";
import { getNotificationChannel, registerNotificationChannel } from "./channels";

describe("notification channel drivers", () => {
  test("creates repeated email payloads without a notification-owned Message-ID", async () => {
    const driver = getNotificationChannel("email");
    if (!driver) throw new Error("Email notification driver is not registered");
    const [destination] = await driver.resolveDestinations({ userId: null, email: "user@example.test" });
    if (!destination) throw new Error("Email notification destination was not resolved");
    const event = { id: "82de6a89-53ed-4b96-a7b7-55ce46ad1cb0", definitionId: "test.email" };

    const first = driver.createPayload({ presentation: { title: "Test" }, destination, event });
    const second = driver.createPayload({ presentation: { title: "Test" }, destination, event });

    expect(first).toEqual({ to: "user@example.test", subject: "Test", content: undefined, rawHtml: undefined });
    expect(first).not.toHaveProperty("messageId");
    expect(second).toEqual(first);
  });

  test("rejects channel ids that cannot be used as stable registry keys", () => {
    expect(() =>
      registerNotificationChannel({
        id: " Browser ",
        resolveDestinations: async () => [],
        createPayload: () => ({}),
        deliver: async () => undefined,
      }),
    ).toThrow("lowercase identifier");
  });
});
