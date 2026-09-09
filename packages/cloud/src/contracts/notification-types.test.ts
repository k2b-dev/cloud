import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineApp } from "../_internal/define-app";
import {
  type AnyBoundNotificationDefinition,
  isSafeNotificationTargetHref,
  type NotificationSendInput,
  notification,
  resolveNotificationDefinitionPresentation,
  validateNotificationTargetHref,
} from "./notification-types";

declare module "@k2b/cloud/contracts/notifications" {
  interface NotificationChannelRegistry {
    mobileTest: true;
  }
}

const NOTIFICATIONS = {
  turnCompleted: notification({
    recipient: "user",
    label: "Completed chats",
    description: "When an Assistant response is ready.",
    presentation: {
      baseLocale: "en",
      translations: { de: { label: "Abgeschlossene Chats", description: "Wenn eine Assistant-Antwort bereit ist." } },
    },
    delivery: { recommended: ["browser"] },
    data: z.object({ conversationId: z.string() }),
    render: ({ conversationId }, { locale }) => ({
      title: locale.startsWith("de") ? "Antwort bereit" : "Response ready",
      targetHref: `/app/assistant/${conversationId}`,
    }),
  }),
  magicLink: notification({
    recipient: "email",
    label: "Sign-in links",
    description: "Required email sign-in links.",
    delivery: { required: ["email"] },
    data: z.object({ token: z.string() }),
    render: () => ({ title: "Sign in" }),
  }),
  mobileReady: notification({
    recipient: "user",
    label: "Mobile test",
    description: "Compile-time coverage for deployment-defined channels.",
    delivery: { recommended: ["mobileTest"] },
    data: z.object({}),
    render: () => ({ title: "Mobile test" }),
  }),
};

const app = defineApp({
  id: "type-test",
  name: "Type test",
  icon: "ti ti-test-pipe",
  description: "Notification type test app.",
  baseUrl: "http://app-type-test:3000",
  routes: ["/app/type-test"],
  notifications: NOTIFICATIONS,
});

const acceptsSend = <D extends AnyBoundNotificationDefinition>(_definition: D, _input: NotificationSendInput<D>) => undefined;

acceptsSend(app.notifications.turnCompleted, {
  recipient: { userId: "user-1" },
  data: { conversationId: "conversation-1" },
  idempotencyKey: "turn-1",
  locale: "de-CH",
});

acceptsSend(app.notifications.magicLink, {
  recipient: { email: "user@example.org" },
  data: { token: "secret" },
  idempotencyKey: "magic-link-1",
});

acceptsSend(app.notifications.turnCompleted, {
  // @ts-expect-error User-targeted kinds cannot bypass preferences with an email address.
  recipient: { email: "user@example.org" },
  data: { conversationId: "c" },
  idempotencyKey: "x",
});

// @ts-expect-error Payload fields retain their schema-inferred types across defineApp.
acceptsSend(app.notifications.turnCompleted, { recipient: { userId: "u" }, data: { conversationId: 42 }, idempotencyKey: "x" });

describe("notification definitions", () => {
  test("bind stable app-qualified ids", () => {
    expect(app.notifications.turnCompleted.id).toBe("type-test.turnCompleted");
    expect(app.notifications.magicLink.id).toBe("type-test.magicLink");
  });

  test("resolves localized definition presentation through language ancestors", () => {
    expect(resolveNotificationDefinitionPresentation(app.notifications.turnCompleted, "de-CH")).toEqual({
      label: "Abgeschlossene Chats",
      description: "Wenn eine Assistant-Antwort bereit ist.",
    });
    expect(resolveNotificationDefinitionPresentation(app.notifications.turnCompleted, "fr")).toEqual({
      label: "Completed chats",
      description: "When an Assistant response is ready.",
    });
  });

  test("validates and canonicalizes localized definition presentation", () => {
    const definition = notification({
      recipient: "user",
      label: "Updates",
      description: "Status updates.",
      presentation: { baseLocale: "EN", translations: { "DE-ch": { label: "Aktualisierungen" } } },
      data: z.object({}),
      render: () => ({ title: "Update" }),
    });
    expect(definition.presentation).toEqual({
      baseLocale: "en",
      translations: { "de-CH": { label: "Aktualisierungen" } },
    });
    expect(() =>
      notification({
        recipient: "user",
        label: "Updates",
        description: "Status updates.",
        presentation: { baseLocale: "en", translations: { EN: { label: "Updates" } } },
        data: z.object({}),
        render: () => ({ title: "Update" }),
      }),
    ).toThrow("must not repeat base locale en");
  });

  test("reject email recipients without required email delivery", () => {
    expect(() =>
      notification({
        recipient: "email",
        label: "Invite",
        description: "Invite by email.",
        data: z.object({}),
        render: () => ({ title: "Invite" }),
      }),
    ).toThrow("must require the email channel");
  });

  test("rejects a channel that is both recommended and required", () => {
    expect(() =>
      notification({
        recipient: "user",
        label: "Conflicting policy",
        description: "Invalid delivery policy fixture.",
        delivery: { recommended: ["browser"], required: ["browser"] },
        data: z.object({}),
        render: () => ({ title: "Conflict" }),
      }),
    ).toThrow('cannot recommend and require the "browser" channel');
  });

  test("accepts only canonical same-origin notification targets", () => {
    expect(isSafeNotificationTargetHref("/app/assistant?conversation=one")).toBe(true);
    expect(isSafeNotificationTargetHref("//evil.example")).toBe(false);
    expect(isSafeNotificationTargetHref("/\\evil.example")).toBe(false);
    expect(() => validateNotificationTargetHref("/app/../admin")).toThrow("canonical same-origin");
  });
});
