import { expect, test } from "bun:test";
import { ContactLiveEventSchema } from "./live-events";

const AT = "2026-07-16T12:00:00.000Z";

test("live events carry only short resource IDs", () => {
  const event = { type: "contact.updated", bookId: "Book01", contactId: "Cont01", at: AT } as const;
  expect(ContactLiveEventSchema.parse(event)).toEqual(event);
  expect(ContactLiveEventSchema.safeParse({ ...event, contactId: "33333333-3333-4333-8333-333333333333" }).success).toBe(false);
  expect(ContactLiveEventSchema.safeParse({ type: "book.updated", bookId: "Book01", at: AT }).success).toBe(true);
});
