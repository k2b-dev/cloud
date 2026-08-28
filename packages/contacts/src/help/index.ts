import { defineHelp } from "@valentinkolb/cloud/server";
import booksDe from "./documents/de/contacts-books-sharing.help.md" with { type: "text" };
import hierarchyDe from "./documents/de/contacts-hierarchy.help.md" with { type: "text" };
import startDe from "./documents/de/contacts-start.help.md" with { type: "text" };
import workDe from "./documents/de/contacts-work.help.md" with { type: "text" };
import books from "./documents/en/contacts-books-sharing.help.md" with { type: "text" };
import hierarchy from "./documents/en/contacts-hierarchy.help.md" with { type: "text" };
import start from "./documents/en/contacts-start.help.md" with { type: "text" };
import work from "./documents/en/contacts-work.help.md" with { type: "text" };

export const contactsHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, work, hierarchy, books],
    de: [startDe, workDe, hierarchyDe, booksDe],
  },
});
