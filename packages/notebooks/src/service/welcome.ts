import { i18n } from "@k2b/stdlib";
import helloDe from "./hello.de.md" with { type: "text" };
import hello from "./hello.md" with { type: "text" };

/** The welcome page a blank notebook starts with, per language; every other language reads the English one. */
const welcomePage = i18n.define({
  baseLocale: "en",
  messages: {
    en: { markdown: hello },
    de: { markdown: helloDe },
  },
});

/**
 * The Markdown of a blank notebook's welcome page in the locale the person creates it in: the same request locale its
 * templates are made in (`templates.instantiate`). German reads the German page; any other locale reads English.
 */
export const welcomeMarkdown = (locale: string | null | undefined): string => welcomePage.resolve(locale ? [locale] : []).t.markdown;
