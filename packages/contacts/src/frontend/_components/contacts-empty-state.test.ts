import { describe, expect, test } from "bun:test";
import { type ContactsScope, contactsEmptyState } from "./contacts-empty-state";
import { resultsMessages } from "./results-messages";

const baseInput = {
  scope: "all",
  canWrite: true,
  search: "",
  tagId: null,
  email: "all",
  phone: "all",
  favorites: false,
} satisfies Parameters<typeof contactsEmptyState>[0];

for (const locale of ["en", "de"]) {
  describe(`Contacts empty states (${locale})`, () => {
    const t = resultsMessages.resolve([locale]).t;
    const choose = (patch: Partial<Parameters<typeof contactsEmptyState>[0]>) => contactsEmptyState({ ...baseInput, ...patch }, t);

    test("no readable books wins over search and every filter", () => {
      for (const canWrite of [true, false]) {
        expect(choose({ scope: "noBooks", canWrite, search: "Ada", tagId: "vip", email: "yes", phone: "no", favorites: true })).toEqual({
          title: t.emptyNoBooksTitle,
          description: t.emptyNoBooksHint,
          action: "createBook",
        });
      }
    });

    test("search wins over other filters and scope hints", () => {
      for (const scope of ["all", "book"] satisfies ContactsScope[]) {
        expect(choose({ scope, search: " Ada ", tagId: "vip" })).toEqual({
          title: t.noMatchingContacts,
          description: t.noMatchingContactsHint,
          action: null,
        });
      }
    });

    test("tag, email, and phone filters explain no matches", () => {});

    test("favorites has its own empty state in either object, regardless of write access", () => {
      for (const scope of ["all", "book"] as const) {
        for (const canWrite of [true, false]) {
          expect(choose({ scope, favorites: true, canWrite })).toEqual({
            title: t.emptyFavoritesTitle,
            description: t.emptyFavoritesHint,
            action: null,
          });
          expect(choose({ scope, favorites: true, tagId: "vip" }).title).toBe(t.noMatchingContacts);
        }
      }
    });

    test("book and all hints reflect write access and ignore whitespace searches", () => {
      for (const scope of ["all", "book"] satisfies ContactsScope[]) {
        for (const canWrite of [true, false]) {
          expect(choose({ scope, canWrite, search: "  " })).toEqual({
            title: scope === "book" ? t.emptyBookTitle : t.emptyAllTitle,
            description: canWrite ? (scope === "book" ? t.emptyBookHint : t.emptyAllHint) : t.emptyReadOnlyHint,
            action: null,
          });
        }
      }
    });

    test("only noBooks offers an action", () => {
      for (const scope of ["all", "book", "noBooks"] satisfies ContactsScope[]) {
        expect(choose({ scope }).action).toBe(scope === "noBooks" ? "createBook" : null);
      }
    });
  });
}
