import { i18n } from "@k2b/stdlib";
import type { ComposeFormattingWarning } from "./contracts";

export const composeFormattingMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Email leaves out some of the HTML in this message.",
      unsupportedElement: ({ element }: { element: string }) => `<${element}> is not supported and was removed. Its text stays.`,
      inlineStyle: ({ element }: { element: string }) =>
        `Inline styles on <${element}> were removed. The mailbox email design styles every message.`,
      unsupportedAttribute: ({ element, attribute }: { element: string; attribute: string }) =>
        `The ${attribute} attribute was removed from <${element}>.`,
      unsupportedLink: "A link address that email does not support was removed. Its text stays.",
    },
    de: {
      title: "Ein Teil des HTML dieser Nachricht wird in der E-Mail weggelassen.",
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
  if (warning.code === "unsupported_element") return t.unsupportedElement({ element: warning.element });
  if (warning.code === "unsupported_link") return t.unsupportedLink;
  if (warning.attribute === "style") return t.inlineStyle({ element: warning.element });
  return t.unsupportedAttribute({ element: warning.element, attribute: warning.attribute ?? "" });
};
