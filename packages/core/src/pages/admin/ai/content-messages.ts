import { i18n } from "@k2b/stdlib";

/** Counts in full and grouped in the catalog's own language (12.345 in German, 12,345 in English). */
const en = (count: number) => count.toLocaleString("en");
const de = (count: number) => count.toLocaleString("de");

/** Words of the AI area's Skills and Projects screens that the shared settings catalog does not have. */
export const aiContentMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      skillsLead: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: `${en(count)} shared Skill`, other: `${en(count)} shared Skills` }),
      projectsLead: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: `${en(count)} shared Project`, other: `${en(count)} shared Projects` }),
      matches: ({ count, search }: { count: number; search: string }) =>
        i18n.plural(count, "en", { one: `${en(count)} match for “${search}”`, other: `${en(count)} matches for “${search}”` }),
      accessAfter: "access entries",
      pageOf: ({ page, pages }: { page: number; pages: number }) => `page ${en(page)} of ${en(pages)}`,
      previousPage: "Previous page",
      nextPage: "Next page",
      skillsUnmanaged: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: "1 Skill without an admin", other: `${en(count)} Skills without an admin` }),
      projectsUnmanaged: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: "1 Project without an admin", other: `${en(count)} Projects without an admin` }),
      unmanagedText: "Nobody can change their access. Open one and add an admin under Permissions.",
      noAdminTitle: "No admin",
      skillNoAdminText: "Nobody can change who uses this Skill. Add an admin under Permissions.",
      projectNoAdminText: "Nobody can change who works in this Project. Add an admin under Permissions.",
      updateText: "The app ships a newer version. Compare to see what would change.",
      admins: ({ count }: { count: number }) => i18n.plural(count, "en", { one: "1 admin", other: `${en(count)} admins` }),
      entries: ({ count }: { count: number }) => i18n.plural(count, "en", { one: "1 entry", other: `${en(count)} entries` }),
      references: "Reference files",
      created: "Created",
      id: "ID",
      state: "State",
      closeDetail: "Close",
      skillsList: "Skills",
      projectsList: "Projects",
      issuesCount: ({ count }: { count: number }) => i18n.plural(count, "en", { one: "1 app Skill", other: `${en(count)} app Skills` }),
      diffLabel: "Differences to the app version",
      details: "Details",
      showAll: "Show all",
      searchPlaceholder: "Name or ID",
    },
    de: {
      skillsLead: ({ count }) => i18n.plural(count, "de", { one: `${de(count)} geteilter Skill`, other: `${de(count)} geteilte Skills` }),
      projectsLead: ({ count }) => i18n.plural(count, "de", { one: `${de(count)} geteiltes Projekt`, other: `${de(count)} geteilte Projekte` }),
      matches: ({ count, search }) =>
        i18n.plural(count, "de", { one: `${de(count)} Treffer für „${search}“`, other: `${de(count)} Treffer für „${search}“` }),
      accessAfter: "Freigaben",
      pageOf: ({ page, pages }) => `Seite ${de(page)} von ${de(pages)}`,
      previousPage: "Vorige Seite",
      nextPage: "Nächste Seite",
      skillsUnmanaged: ({ count }) => i18n.plural(count, "de", { one: "1 Skill ohne Administration", other: `${de(count)} Skills ohne Administration` }),
      projectsUnmanaged: ({ count }) =>
        i18n.plural(count, "de", { one: "1 Projekt ohne Administration", other: `${de(count)} Projekte ohne Administration` }),
      unmanagedText: "Niemand kann ihren Zugriff ändern. Öffne eines und trage unter Berechtigungen eine Administration ein.",
      noAdminTitle: "Keine Administration",
      skillNoAdminText: "Niemand kann ändern, wer diesen Skill nutzt. Trage unter Berechtigungen eine Administration ein.",
      projectNoAdminText: "Niemand kann ändern, wer in diesem Projekt arbeitet. Trage unter Berechtigungen eine Administration ein.",
      updateText: "Die App liefert eine neuere Fassung. Vergleiche, um zu sehen, was sich ändern würde.",
      admins: ({ count }) => i18n.plural(count, "de", { one: "1 Administrator", other: `${de(count)} Administratoren` }),
      entries: ({ count }) => i18n.plural(count, "de", { one: "1 Eintrag", other: `${de(count)} Einträge` }),
      references: "Referenzdateien",
      created: "Angelegt",
      id: "ID",
      state: "Stand",
      closeDetail: "Schließen",
      skillsList: "Skills",
      projectsList: "Projekte",
      issuesCount: ({ count }) => i18n.plural(count, "de", { one: "1 App-Skill", other: `${de(count)} App-Skills` }),
      diffLabel: "Unterschiede zur App-Fassung",
      details: "Angaben",
      showAll: "Alle zeigen",
      searchPlaceholder: "Name oder ID",
    },
  },
});

export type AiContentMessages = ReturnType<typeof aiContentMessages.resolve>["t"];
