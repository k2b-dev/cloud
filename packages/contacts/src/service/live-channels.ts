import type { LiveViewer } from "@k2b/cloud/events";
import { hasPermission } from "@k2b/cloud/server";
import { z } from "zod";
import { ResourceShortIdSchema } from "../capability-contracts";
import { CONTACT_BOOK_RESOURCE_TYPE, CONTACTS_APP_ID, getActorsBookPermissions } from "./access";
import * as books from "./books";
import { resolvePublicId } from "./public-resources";

/** Viewers who may read one book, decided like the Contacts API, with one query for all of them. Keys are internal book IDs. */
const bookReaders = async (bookId: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>> => {
  if (!(await books.get({ id: bookId }))) return new Set();
  const permissions = await getActorsBookPermissions(
    bookId,
    viewers.map((viewer) => ({ actor: viewer.actor, subject: viewer.accessSubject })),
  );
  return new Set(viewers.filter((_, position) => hasPermission(permissions[position] ?? "none", "read")).map((viewer) => viewer.id));
};

/** The book a resource-bound key may read; every other caller reads through its grants. */
const boundBookId = ({ actor }: LiveViewer): string | null =>
  actor.kind === "service_account" &&
  actor.serviceAccount.kind === "resource_bound" &&
  actor.serviceAccount.appId === CONTACTS_APP_ID &&
  actor.serviceAccount.resourceType === CONTACT_BOOK_RESOURCE_TYPE
    ? (actor.serviceAccount.resourceId ?? null)
    : null;

/** `book` follows one book; `all` follows every book its viewer can read (Cloud follows the first 1,000). */
export const contactsLiveChannels = {
  book: {
    scope: z.object({ book: ResourceShortIdSchema }).strict(),
    keys: async ({ book }: { book: string }) => {
      const bookId = await resolvePublicId("books", book);
      return bookId ? [bookId] : null;
    },
    authorize: bookReaders,
  },
  all: {
    scope: z.object({}).strict(),
    collection: true as const,
    keys: async (_scope: unknown, viewer: LiveViewer) =>
      (await books.list({ subject: viewer.accessSubject, boundBookId: boundBookId(viewer) })).map((book) => book.id),
    authorize: bookReaders,
  },
};
