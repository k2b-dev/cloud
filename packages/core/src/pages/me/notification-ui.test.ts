import { describe, expect, test } from "bun:test";
import { notificationChannelAvailability } from "./notification-ui";

describe("notification channel availability", () => {
  test("keeps registered channels selectable without checking local browser state", () => {
    expect(notificationChannelAvailability(true)).toEqual({ enabled: true });
  });

  test("uses the app reason for an excluded channel even when it is registered", () => {
    for (const registered of [true, false]) {
      expect(notificationChannelAvailability(registered, "de", "Jede Nachricht als E-Mail wäre zu viel.")).toEqual({
        enabled: false,
        description: "Jede Nachricht als E-Mail wäre zu viel.",
      });
    }
  });

  test("disables channels that are not registered by the platform", () => {
    expect(notificationChannelAvailability(false)).toEqual({
      enabled: false,
      description: "This channel is currently unavailable.",
    });
  });
});
