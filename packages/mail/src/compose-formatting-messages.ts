import { i18n } from "@k2b/stdlib";
import type { ComposeFormattingWarning } from "./contracts";

export const composeFormattingMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      ignoredMailboxCss: ({ properties }: { properties: string }) =>
        `This design contains values that email no longer accepts: ${properties}. Messages still send without them. Remove or replace them and save the design.`,
      ignoredMailboxCssProperty: ({ property }: { property: string }) =>
        `The mailbox email design sets ${property} to a value email no longer accepts. Mail ignores it.`,
      ignoredMailboxCssDesign: "Email no longer accepts the mailbox email design, so Mail uses the built-in design.",
      title: "Email leaves out some formatting of this message.",
      unsupportedElement: ({ element }: { element: string }) => `<${element}> is not supported and was removed. Its text stays.`,
      inlineStyle: ({ element }: { element: string }) =>
        `Inline styles on <${element}> were removed. The mailbox email design styles every message.`,
      unsupportedAttribute: ({ element, attribute }: { element: string; attribute: string }) =>
        `The ${attribute} attribute was removed from <${element}>.`,
      unsupportedLink: "A link address that email does not support was removed. Its text stays.",
    },
    de: {
      ignoredMailboxCss: ({ properties }) =>
        `Dieses Design enthält Werte, die E-Mails nicht mehr zulassen: ${properties}. Nachrichten werden ohne sie gesendet. Entferne oder ersetze sie und speichere das Design.`,
      ignoredMailboxCssProperty: ({ property }) =>
        `Das E-Mail-Design des Postfachs setzt ${property} auf einen Wert, den E-Mails nicht mehr zulassen. Mail ignoriert ihn.`,
      ignoredMailboxCssDesign: "E-Mails lassen das E-Mail-Design des Postfachs nicht mehr zu, darum verwendet Mail das integrierte Design.",
      title: "Ein Teil der Formatierung dieser Nachricht wird in der E-Mail weggelassen.",
      unsupportedElement: ({ element }) => `<${element}> wird nicht unterstützt und wurde entfernt. Der Text bleibt erhalten.`,
      inlineStyle: ({ element }) =>
        `Inline-Stile an <${element}> wurden entfernt. Das E-Mail-Design des Postfachs gestaltet jede Nachricht.`,
      unsupportedAttribute: ({ element, attribute }) => `Das Attribut ${attribute} wurde von <${element}> entfernt.`,
      unsupportedLink: "Eine Linkadresse, die E-Mails nicht unterstützen, wurde entfernt. Der Text bleibt erhalten.",
    },
  },
});

/** One line per warning, in the reader's language. */
export const describeComposeFormattingWarning = (warning: ComposeFormattingWarning, locale: string | undefined): string => {
  const t = composeFormattingMessages.resolve([locale ?? "en"]).t;
  if (warning.code === "ignored_mailbox_css") {
    return warning.property ? t.ignoredMailboxCssProperty({ property: warning.property }) : t.ignoredMailboxCssDesign;
  }
  if (warning.code === "unsupported_element") return t.unsupportedElement({ element: warning.element });
  if (warning.code === "unsupported_link") return t.unsupportedLink;
  if (warning.attribute === "style") return t.inlineStyle({ element: warning.element });
  return t.unsupportedAttribute({ element: warning.element, attribute: warning.attribute ?? "" });
};

/** One notice for the values of a stored mailbox design that email ignores, or null when it ignores none. */
export const describeIgnoredMailboxCss = (warnings: ComposeFormattingWarning[], locale: string | undefined): string | null => {
  const ignored = warnings.flatMap((warning) => (warning.code === "ignored_mailbox_css" ? [warning] : []));
  const [first] = ignored;
  if (!first) return null;
  // Without a property, email ignores the whole design.
  if (first.property === undefined) return describeComposeFormattingWarning(first, locale);
  const properties = ignored.flatMap((warning) => (warning.property === undefined ? [] : [warning.property]));
  return composeFormattingMessages.resolve([locale ?? "en"]).t.ignoredMailboxCss({ properties: properties.join(", ") });
};
