import type { LiveViewer } from "@k2b/cloud/events";
import { hasPermission } from "@k2b/cloud/server";
import { z } from "zod";
import { ResourceShortIdSchema } from "../capability-contracts";
import { getActorsBookPermissions, readableBookScope } from "./access";
import * as books from "./books";
import { resolvePublicId } from "./public-resources";

/** Viewers who may read one book, decided like the Contacts API, with one query for all of them. Keys are internal book IDs. */
const bookReaders = async (bookId: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>> => {
  if (!(await books.get({ id: bookId }))) return new Set();
  const permissions = await getActorsBookPermissions(
    bookId,
    viewers.map((viewer) => ({ actor: viewer.actor, accessSubject: viewer.accessSubject })),
  );
  return new Set(viewers.filter((_, position) => hasPermission(permissions[position] ?? "none", "read")).map((viewer) => viewer.id));
};

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
    keys: async (_scope: unknown, viewer: LiveViewer) => {
      const scope = readableBookScope(viewer);
      if (!scope.ok) return [];
      return (await books.list({ subject: viewer.accessSubject, ...scope.data })).map((book) => book.id);
    },
    authorize: bookReaders,
  },
};
