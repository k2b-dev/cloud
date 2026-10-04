import { defineLive } from "@k2b/cloud/events";
import { logger } from "@k2b/cloud/services";
import type { SQL } from "bun";
import { type ContactLiveEvent, ContactLiveEventSchema } from "../live-events";

const log = logger("contacts:live");
const CURSOR_TIMEOUT_MS = 1_500;

/** Live updates keyed by the internal book ID: every reader of a book may see its updates. */
export const contactsLive = defineLive({ appId: "contacts", event: ContactLiveEventSchema });

/** A change with internal IDs; `publishContactChange` turns them into public IDs. */
export type ContactChange = ContactLiveEvent extends infer Event ? (Event extends { at: string } ? Omit<Event, "at"> : never) : never;

/**
 * Writes one change in `tx`, the transaction that makes it. Call it while the
 * book and contact it names still exist in `tx`. A change of who may read the
 * book is published as an access change, so open pages check it at once.
 */
export const publishContactChange = async (tx: SQL, change: ContactChange): Promise<void> => {
  const contactId = "contactId" in change ? change.contactId : null;
  const [ids] = await tx<{ book: string | null; contact: string | null }[]>`
    SELECT
      (SELECT short_id FROM contacts.books WHERE id = ${change.bookId}::uuid) AS book,
      (SELECT short_id FROM contacts.contacts WHERE id = ${contactId}::uuid) AS contact
  `;
  if (!ids?.book || (contactId && !ids.contact)) throw new Error(`Contacts ${change.type} names a missing resource`);
  const data = ContactLiveEventSchema.parse({
    ...change,
    bookId: ids.book,
    ...(contactId ? { contactId: ids.contact } : {}),
    at: new Date().toISOString(),
  });
  await contactsLive.publish(tx, { key: change.bookId, data, ...(change.type === "access.changed" ? { access: true as const } : {}) });
};

const withTimeout = async <T>(operation: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Contacts live topic timed out")), CURSOR_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * SSR stays available when the live transport is slow or down. `null` makes
 * the island subscribe without a cursor, at the current position.
 */
export const captureContactLiveCursor = async (): Promise<string | null> => {
  try {
    return await withTimeout(contactsLive.cursor());
  } catch (error) {
    log.warn("Failed to capture the Contacts live cursor", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
};
