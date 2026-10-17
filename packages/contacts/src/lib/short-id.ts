import { isUniqueViolation } from "@k2b/cloud/services";
import { crypto } from "@k2b/stdlib";

export const SHORT_ID_REGEX = /^[0-9A-Za-z]{6}$/;
export const SHORT_ID_LENGTH = 6;

export type ShortIdTable = "book" | "contact" | "tag" | "note";

const MAX_ATTEMPTS = 10;

const constraintByTable: Record<ShortIdTable, string> = {
  book: "idx_contacts_books_short_id",
  contact: "idx_contacts_contacts_short_id",
  tag: "idx_contacts_tags_short_id",
  note: "idx_contacts_notes_short_id",
};

export const newShortId = (): string => crypto.common.readableId(SHORT_ID_LENGTH);

const isShortIdCollision = (error: unknown, tables: readonly ShortIdTable[]): boolean =>
  tables.some((table) => isUniqueViolation(error, constraintByTable[table]));

export const withShortIdRetry = async <T>(tables: readonly ShortIdTable[], write: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!isShortIdCollision(error, tables)) throw error;
    }
  }
  throw new Error(`Failed to allocate a short ID for ${tables.join(", ")}`);
};

export const withShortId = <T>(table: ShortIdTable, write: (shortId: string) => Promise<T>): Promise<T> =>
  withShortIdRetry([table], () => write(newShortId()));
