import type { LiveViewer } from "@k2b/cloud/events";
import { hasPermission } from "@k2b/cloud/server";
import { z } from "zod";
import { ResourceShortIdSchema } from "../capability-contracts";
import { CONTACT_BOOK_RESOURCE_TYPE, CONTACTS_APP_ID, getActorBookPermission } from "./access";
import * as books from "./books";
import { resolvePublicId } from "./public-resources";

const MAX_BOOKS = 1_000;

/** Viewers who may read one book, decided like the Contacts API. Keys are internal book IDs. */
const bookReaders = async (bookId: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>> => {
  const readers = new Set<string>();
  if (!(await books.get({ id: bookId }))) return readers;
  for (const viewer of viewers) {
    const permission = await getActorBookPermission({ bookId, actor: viewer.actor, subject: viewer.accessSubject });
    if (hasPermission(permission, "read")) readers.add(viewer.id);
  }
  return readers;
};

/** The book a resource-bound key may read; every other caller reads through its grants. */
const boundBookId = ({ actor }: LiveViewer): string | null =>
  actor.kind === "service_account" &&
  actor.serviceAccount.kind === "resource_bound" &&
  actor.serviceAccount.appId === CONTACTS_APP_ID &&
  actor.serviceAccount.resourceType === CONTACT_BOOK_RESOURCE_TYPE
    ? (actor.serviceAccount.resourceId ?? null)
    : null;

/** `book` follows one book; `all` follows every book its viewer can read. */
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
      (await books.list({ subject: viewer.accessSubject, boundBookId: boundBookId(viewer) })).slice(0, MAX_BOOKS).map((book) => book.id),
    authorize: bookReaders,
  },
};
