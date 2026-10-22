/**
 * Markdown language without `@codemirror/lang-markdown`: that package pulls in
 * `@codemirror/lang-html` (and with it CSS and JavaScript) for HTML blocks.
 * The shared editor needs only the GFM tree, so it wraps `@lezer/markdown`.
 */
import { defineLanguageFacet, Language, LanguageSupport } from "@codemirror/language";
import { GFM, parser } from "@lezer/markdown";

const facet = defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } });
const gfmParser = parser.configure([GFM]);

export const markdownLanguage = new Language(facet, gfmParser, [], "markdown");
export const markdown = () => new LanguageSupport(markdownLanguage);
