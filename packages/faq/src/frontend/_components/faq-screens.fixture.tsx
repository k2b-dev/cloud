import { LocaleProvider } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import type { FaqEntry } from "@/contracts";
import { faqMessages } from "../messages";
import FaqAdminScreen from "./FaqAdminScreen";
import FaqScreen from "./FaqScreen";
import { openFromAddress } from "./faq-admin-open";

// Invented entries for render and browser tests; no real data.
const entry = (
  id: string,
  en: [string, string],
  de: [string, string] | null,
  audience: FaqEntry["audience"],
  position: number,
): FaqEntry => ({
  id,
  translations: { en: { question: en[0], answer: en[1] }, ...(de ? { de: { question: de[0], answer: de[1] } } : {}) },
  audience,
  position,
  createdAt: "2026-11-02T09:00:00.000Z",
});

export const FIXTURE_ENTRIES: FaqEntry[] = [
  entry(
    "0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e1001",
    [
      "How do I reset my password?",
      "Open **Profile › Security** and choose *Reset password*. A link arrives by mail within a few minutes.",
    ],
    [
      "Wie setze ich mein Passwort zurück?",
      "Öffne **Profil › Sicherheit** und wähle *Passwort zurücksetzen*. Ein Link kommt in wenigen Minuten per Mail.",
    ],
    ["guest", "user"],
    0,
  ),
  entry(
    "0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e1002",
    ["Who can see a shared address book?", "Everyone you add as a member. Readers see contacts; writers can change them."],
    [
      "Wer sieht ein geteiltes Adressbuch?",
      "Alle, die du als Mitglied hinzufügst. Lesende sehen die Kontakte, Schreibende können sie ändern.\n\n- Lesen\n- Schreiben\n- Verwalten",
    ],
    ["user"],
    1,
  ),
  entry(
    "0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e1003",
    ["Where do I find the opening hours?", "See [the contact page](https://example.org/contact)."],
    null,
    ["anonymous", "guest", "user"],
    2,
  ),
];

/** The worst case of the break-ui catalog: unbreakable words, very long questions, non-Latin text, emoji, code. */
export const WORST_ENTRIES: FaqEntry[] = [
  entry(
    "0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e2001",
    [
      "Warum-zeigt-die-Synchronisierung-meines-Adressbuchs-mit-dem-Telefon-https://cloud.example.org/app/contacts/carddav/principals/sehr-langer-name-ohne-leerzeichen keine Kontakte?",
      "```\ncurl -u name:token https://cloud.example.org/app/contacts/carddav/principals/sehr-langer-name-ohne-leerzeichen-und-noch-viel-laenger/addressbooks/\n```\n\nPrüfe den Benutzernamen.",
    ],
    ["Warum-zeigt-die-Synchronisierung-ohne-Leerzeichen-sehr-lang-sehr-lang-sehr-lang-sehr-lang?", "Weil."],
    ["anonymous", "guest", "user"],
    0,
  ),
  entry("0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e2002", ["?", "!"], null, ["user"], 1),
  entry(
    "0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e2003",
    ["日本語の質問はどこに表示されますか？ 🧭🧭🧭", "مرحبا — Antworten in jeder Schrift: 中文, Ελληνικά, עברית. 🎉"],
    null,
    ["guest"],
    2,
  ),
  ...Array.from({ length: 40 }, (_, index) =>
    entry(
      `0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e3${String(index).padStart(3, "0")}`,
      [`Question number ${index + 1} about invoices, receipts and the yearly export`, `Answer ${index + 1}.`],
      index % 2 ? [`Frage Nummer ${index + 1} zu Rechnungen, Belegen und dem Jahresexport`, `Antwort ${index + 1}.`] : null,
      ["user"],
      index + 3,
    ),
  ),
];

/** The admin bar as `adminNavigation(c)` builds it, shortened to a few invented entries. */
export const FIXTURE_NAV: NavProps = {
  title: "Administration",
  icon: "settings",
  groups: [
    { items: [{ label: "Übersicht", icon: "layout-dashboard", href: "/admin" }] },
    {
      label: "Apps",
      items: [
        { label: "Dateien", icon: "folder", href: "/admin/files" },
        { label: "FAQ", icon: "help", href: "/admin/faq", current: true },
        { label: "Mail", icon: "mail", href: "/admin/mail" },
      ],
    },
  ],
};

const resolve = (item: FaqEntry, locale: string) =>
  locale === "de" && item.translations.de ? item.translations.de : item.translations.en!;

/** The public FAQ as the page renders it. */
export const FaqScreenFixture = (props: { locale?: string; worst?: boolean; empty?: boolean }) => {
  const locale = props.locale ?? "de";
  const source = props.empty ? [] : props.worst ? WORST_ENTRIES : FIXTURE_ENTRIES;
  return (
    <LocaleProvider locale={locale}>
      <FaqScreen t={faqMessages.resolve([locale]).t} entries={source.map((item) => ({ id: item.id, ...resolve(item, locale) }))} />
    </LocaleProvider>
  );
};

/** The FAQ administration for one address, as the page renders it: `?entry=<id>` or `?entry=new` opens the form. */
export const FaqAdminFixture = (props: { search?: string; locale?: string; worst?: boolean; empty?: boolean }) => {
  const locale = props.locale ?? "de";
  const source = props.empty ? [] : props.worst ? WORST_ENTRIES : FIXTURE_ENTRIES;
  const entries = source.map((item) => ({ entry: item, question: resolve(item, locale).question }));
  const open = openFromAddress(entries, new URLSearchParams(props.search ?? "").get("entry"));
  return (
    <LocaleProvider locale={locale}>
      <FaqAdminScreen nav={FIXTURE_NAV} entries={entries} open={open} />
    </LocaleProvider>
  );
};
