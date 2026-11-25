import type { FaqEntry } from "@/contracts";

/** One entry of the admin list, its question already in the reader's locale. */
export type FaqAdminEntry = { entry: FaqEntry; question: string };

/** What the address has open beside the list: a new entry, an existing one, or one that no longer exists. */
export type FaqAdminOpen = { kind: "new" } | { kind: "edit"; entry: FaqEntry; question: string } | { kind: "missing" };

/** Reads `?entry=` against the listed entries: `new` opens an empty form, an unknown ID says the entry is gone. */
export const openFromAddress = (entries: readonly FaqAdminEntry[], wanted: string | null | undefined): FaqAdminOpen | null => {
  if (!wanted) return null;
  if (wanted === "new") return { kind: "new" };
  const found = entries.find((item) => item.entry.id === wanted);
  return found ? { kind: "edit", entry: found.entry, question: found.question } : { kind: "missing" };
};
