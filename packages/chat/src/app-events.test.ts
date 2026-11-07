import { expect, test } from "bun:test";
import { APP_EVENT_MAX_BYTES } from "@k2b/cloud/contracts/app-events";
import { appEventFixture, createAppEventTestHarness } from "@k2b/cloud/events/testing";
import { chatCapabilities } from "./capabilities";
import { MAX_MENTIONS } from "./service/contracts";

const principal = { type: "service_account" as const, id: "11111111-1111-4111-8111-111111111111" };

test("Chat declares a posted-message resource event with readable public refs", () => {
  const { manifest } = createAppEventTestHarness("chat", chatCapabilities);
  expect(manifest.events).toContainEqual(
    expect.objectContaining({
      localId: "message.posted",
      version: 1,
      subject: "message",
      place: "conversation",
    }),
  );
  expect(manifest.types.find((type) => type.localId === "conversation")?.reader).toBe("conversation.read");
  expect(manifest.types.find((type) => type.localId === "message")?.reader).toBe("message.read");
});

test("Chat payload contains bounded principal refs and cause, never content", () => {
  createAppEventTestHarness("chat", chatCapabilities);
  const input = {
    subject: "Message001",
    place: "Chat01",
    requestId: "post-request",
    data: { threadReply: false, root: null, author: principal, mentions: [] },
  };
  const event = appEventFixture(chatCapabilities, "message.posted", input);
  expect(event).toMatchObject({
    type: "chat.message.posted",
    version: 1,
    source: "chat",
    subject: { type: "chat.message", id: "Message001" },
    place: { type: "chat.conversation", id: "Chat01" },
    cause: { requestId: "post-request" },
    data: input.data,
  });
  const withContent = { ...input, data: { ...input.data, body: "private" } };
  expect(() => appEventFixture(chatCapabilities, "message.posted", withContent)).toThrow();
  expect(() =>
    appEventFixture(chatCapabilities, "message.posted", {
      ...input,
      data: { ...input.data, mentions: Array(MAX_MENTIONS + 1).fill(principal) },
    }),
  ).toThrow();
  const maximum = appEventFixture(chatCapabilities, "message.posted", {
    ...input,
    requestId: "\u0001".repeat(256),
    data: {
      threadReply: true,
      root: { type: "chat.message", id: "Message002" },
      author: principal,
      mentions: Array.from({ length: MAX_MENTIONS }, () => principal),
    },
  });
  // jsonb adds a space after each separator. This upper bound includes every separator in a compact envelope.
  const compact = JSON.stringify(maximum);
  const bytes = Buffer.byteLength(compact) + (compact.match(/[:,]/g)?.length ?? 0);
  expect(bytes).toBeLessThan(APP_EVENT_MAX_BYTES);
});

test("Chat capacity fixtures measure thin and full-mention envelopes", () => {
  createAppEventTestHarness("chat", chatCapabilities);
  const thin = { subject: "Message001", place: "Chat01", data: { threadReply: false, root: null, author: principal, mentions: [] } };
  const minimal = appEventFixture(chatCapabilities, "message.posted", thin);
  expect(Buffer.byteLength(JSON.stringify(minimal))).toBe(374);
  const mentions = appEventFixture(chatCapabilities, "message.posted", {
    ...thin,
    data: {
      ...thin.data,
      threadReply: true,
      root: { type: "chat.message", id: "Message002" },
      mentions: Array.from({ length: MAX_MENTIONS }, () => principal),
    },
  });
  expect(Buffer.byteLength(JSON.stringify(mentions))).toBe(1829);
});
