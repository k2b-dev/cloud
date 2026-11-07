import { expect, test } from "bun:test";
import { appEventFixture, createAppEventTestHarness } from "@k2b/cloud/events/testing";
import { mailCapabilities } from "./capabilities";

const receiptId = "11111111-1111-4111-8111-111111111111";

test("Mail declares a bounded, reference-only message receipt at its mailbox", () => {
  const harness = createAppEventTestHarness("mail", mailCapabilities);
  expect(harness.manifest.events).toContainEqual(
    expect.objectContaining({
      localId: "message.received",
      version: 1,
      subject: "message",
      place: "mailbox",
    }),
  );
  const input = { subject: "Msg123", place: "Box123", data: { receiptId } };
  const event = appEventFixture(mailCapabilities, "message.received", input);
  expect(event).toMatchObject({
    type: "mail.message.received",
    version: 1,
    source: "mail",
    subject: { type: "mail.message", id: "Msg123" },
    place: { type: "mail.mailbox", id: "Box123" },
    data: { receiptId },
  });
  expect(Buffer.byteLength(JSON.stringify(event))).toBe(292);
  expect(mailCapabilities.types.message.reader).toBe("message.read");
  expect(mailCapabilities.types.mailbox.reader).toBe("mailbox.read");
  const withContent = { ...input, data: { receiptId, subject: "private content" } };
  expect(() => appEventFixture(mailCapabilities, "message.received", withContent)).toThrow();
  expect(() =>
    appEventFixture(mailCapabilities, "message.received", {
      ...input,
      data: { receiptId: "unbounded provider identity" },
    }),
  ).toThrow();
});
