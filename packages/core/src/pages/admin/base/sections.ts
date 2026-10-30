import type { RegistryFormSection } from "../_area/RegistryForm.island";
import { settingsMessages } from "../settings/_components/messages";
import { baseText } from "./area";

/** The fields of each registry section, grouped and ordered by hand. */
export const generalSections = (locale: string): RegistryFormSection[] => {
  const t = baseText(locale);
  return [
    { title: t.groupIdentity, keys: ["app.name", "app.logo", "app.favicon"] },
    { title: t.groupLanguage, keys: ["app.locale", "app.timezone"] },
    { title: t.groupAddress, keys: ["app.url", "app.home_path"] },
    {
      title: t.groupContact,
      description: t.groupContactDescription,
      keys: ["app.contact_email", "app.copyright", "app.documentation_url"],
    },
    { title: t.groupMaintenance, keys: ["app.cleanup_schedule", "outgoing_mail.allowed_targets", "gateway.trusted_proxies"] },
  ];
};

export const legalSections = (locale: string): RegistryFormSection[] => {
  const s = settingsMessages.resolve([locale]).t;
  return (
    [
      ["terms", s.terms, s.termsDescription, "/legal/terms"],
      ["privacy", s.privacy, s.privacyDescription, "/legal/privacy"],
      ["imprint", s.imprint, s.imprintDescription, "/impressum"],
    ] as const
  ).map(([kind, title, description, href]) => ({
    title,
    description,
    keys: [`legal.${kind}.mode`, `legal.${kind}.content`, `legal.${kind}.url`],
    shownWhen: {
      [`legal.${kind}.content`]: { key: `legal.${kind}.mode`, value: "local" },
      [`legal.${kind}.url`]: { key: `legal.${kind}.mode`, value: "external" },
    },
    link: { label: s.open, href },
  }));
};

export const pdfSections = (locale: string): RegistryFormSection[] => {
  const t = baseText(locale);
  return [
    { title: t.groupConnection, keys: ["gotenberg.url", "gotenberg.username", "gotenberg.password", "gotenberg.timeout_ms"] },
    { title: t.groupLimits, keys: ["gotenberg.max_html_bytes", "gotenberg.max_pdf_bytes"] },
  ];
};

export const cliSections = (locale: string): RegistryFormSection[] => [
  { title: baseText(locale).groupPlugins, keys: ["cli.plugins.access"] },
];
