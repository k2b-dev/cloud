/**
 * Root scheme-less Cloud resource links in sanitized Assistant answer HTML, and turn citations into numbered chips.
 * Normalized links stay root-relative under /app/ or /open/ and can never change origin.
 *
 * A citation is a link whose whole text is a number from 1 to 99, as the system prompt asks Gustav to write it right
 * after a statement: `[1](/open/mail.thread/~…)`. It keeps its destination and opens like any link, but reads as a
 * small grey chip with the number (`.ai-cite`); `citeLabel` names it for screen readers ("Source 1"). A chip sits right at
 * the word it follows and keeps that word and the punctuation after it on its line (`.ai-cite-run`).
 */
export function rootResourceLinks(html: string, citeLabel?: (number: string) => string): string {
  // sanitize-html emits double-quoted attributes with ", <, and > escaped in values.
  const rooted = html.replace(/<a\b[^>]*>/g, (tag) => tag.replace(/(\shref=")((?:app|open)\/)/g, "$1/$2"));
  const label = (number: string) => (citeLabel ? ` aria-label="${citeLabel(number).replaceAll('"', "&quot;")}"` : "");
  const chip = (attributes: string, number: string) =>
    `<a${attributes} class="ai-cite" data-cite="${number}"${label(number)}>${number}</a>`;
  const { body, destinations } = takeSourceList(rooted);
  const linked = body.replace(CITATION, (_link, attributes: string, number: string) => {
    const kept = linkAttributes(attributes);
    if (!destinations.has(number)) destinations.set(number, kept);
    return chip(kept, number);
  });
  const marked = markBareCitations(linked, (number) => {
    const kept = destinations.get(number);
    return kept === undefined ? null : chip(kept, number);
  });
  return marked.replace(CITATION_RUN, (_run, word: string, chips: string, punctuation = "") =>
    `<span class="ai-cite-run">${word}${chips.replace(/>\s+</g, "><")}${punctuation.trim()}</span>`,
  );
}

/**
 * A chip is an inline block, and a line may break before and after an inline block even with no space around it. So
 * the word before a chip, the chip, further chips, and the punctuation after them form one run that does not wrap
 * (`.ai-cite-run`), and the space a model writes before a chip or before that punctuation ("Uhr [1] .") goes away.
 */
const CHIP = String.raw`<a\b[^>]*\sclass="ai-cite"[^>]*>[1-9]\d?<\/a>`;
const CLOSING_PUNCTUATION = String.raw`(?:[.,;:!?…)\]}»”’]|&quot;|&#39;)`;
const CITATION_RUN = new RegExp(
  String.raw`([^\s<>]*)\s*((?:${CHIP}\s*)*${CHIP})(\s*${CLOSING_PUNCTUATION}+)?`,
  "g",
);

/** A link's own attributes without what made it a reference or an inline link: its destination and how it opens. */
const linkAttributes = (attributes: string) => attributes.replace(/\s(?:class|data-reference|data-link|aria-label)="[^"]*"/g, "");

/**
 * Some models add their own list of sources at the end ("Sources: [1] Note [Inbox](…) · [2] …") instead of only citing
 * in the text. The chat lists cited sources under the answer, so a trailing block of that shape is taken out of the
 * answer, and each number keeps the first link of its entry as its destination. Only a block that starts with a short
 * label and holds numbered entries with links counts; anything else stays text.
 */
const takeSourceList = (html: string): { body: string; destinations: Map<string, string> } => {
  const destinations = new Map<string, string>();
  const label = String.raw`<p>\s*(?:<strong>)?\s*[^<>\[\]:]{1,24}:\s*(?:<\/strong>)?`;
  const inline = new RegExp(String.raw`${label}\s*((?:\[|<a\b)[\s\S]*?)<\/p>\s*$`);
  const listed = new RegExp(String.raw`${label}\s*<\/p>\s*<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>\s*$`);
  const match = listed.exec(html) ?? inline.exec(html);
  if (!match) return { body: html, destinations };
  const entries = match[2] ?? match[1] ?? "";
  for (const entry of entries.matchAll(ENTRY)) {
    const number = entry[2] ?? entry[3]!;
    const attributes = entry[1] ?? /<a\b([^>]*\shref="[^"]*"[^>]*)>/.exec(entry[4] ?? "")?.[1];
    if (attributes !== undefined && !destinations.has(number)) destinations.set(number, linkAttributes(attributes));
  }
  if (destinations.size === 0) return { body: html, destinations };
  return { body: html.slice(0, match.index).trimEnd(), destinations };
};

/** One entry of a source list: a numbered link, or a bare `[n]` and its text up to the next entry. */
const ENTRY =
  /(?:<a\b([^>]*\shref="[^"]*"[^>]*)>(?:<i\b[^>]*><\/i>)?([1-9]\d?)(?:<i\b[^>]*><\/i>)?<\/a>)|\[([1-9]\d?)\]((?:(?!\[[1-9]\d?\]|<a\b[^>]*>(?:<i\b[^>]*><\/i>)?[1-9]\d?(?:<i\b[^>]*><\/i>)?<\/a>)[\s\S])*)/g;

/** Bare `[n]` in the answer's text, outside links and code, become chips when their number has a destination. */
const markBareCitations = (html: string, chip: (number: string) => string | null): string => {
  let shielded = 0;
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        const tag = /^<(\/?)(a|code|pre)\b/i.exec(part);
        if (tag) shielded += tag[1] ? -1 : 1;
        return part;
      }
      return shielded > 0 ? part : part.replace(/\[([1-9]\d?)\]/g, (text, number: string) => chip(number) ?? text);
    })
    .join("");
};

/** A link whose text is only a citation number; the markdown renderer adds a type or external icon around it. */
const CITATION = /<a\b([^>]*)>(?:<i\b[^>]*><\/i>)?([1-9]\d?)(?:<i\b[^>]*><\/i>)?<\/a>/g;

const unescapeAttribute = (value: string) =>
  value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/**
 * Citations in an answer's rendered, sanitized HTML, in number order: the numbered links `rootResourceLinks` turns into
 * chips. Reading the HTML, not the Markdown source, keeps the sanitizer's URL policy and the parser's view of code and
 * destinations. A number keeps its first destination.
 */
export const answerCitations = (html: string): { number: number; href: string }[] => {
  const citations = new Map<number, string>();
  for (const match of rootResourceLinks(html).matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*\bdata-cite="(\d+)"[^>]*>/g)) {
    const number = Number(match[2]);
    if (!citations.has(number)) citations.set(number, unescapeAttribute(match[1]!));
  }
  return [...citations].map(([number, href]) => ({ number, href })).sort((a, b) => a.number - b.number);
};
