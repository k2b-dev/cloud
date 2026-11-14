/**
 * Root scheme-less Cloud resource links in sanitized Assistant answer HTML, and turn citations into numbered chips.
 * Normalized links stay root-relative under /app/ or /open/ and can never change origin.
 *
 * A citation is a link whose whole text is a number from 1 to 99, as the system prompt asks Gustav to write it right
 * after a statement: `[1](/open/mail.thread/~…)`. It keeps its destination and opens like any link, but reads as a
 * small grey chip with the number (`.ai-cite`); `citeLabel` names it for screen readers ("Source 1").
 */
export function rootResourceLinks(html: string, citeLabel?: (number: string) => string): string {
  // sanitize-html emits double-quoted attributes with ", <, and > escaped in values.
  const rooted = html.replace(/<a\b[^>]*>/g, (tag) => tag.replace(/(\shref=")((?:app|open)\/)/g, "$1/$2"));
  return rooted.replace(CITATION, (_link, attributes: string, number: string) => {
    const kept = attributes.replace(/\s(?:class|data-reference|data-link|aria-label)="[^"]*"/g, "");
    const label = citeLabel ? ` aria-label="${citeLabel(number).replaceAll('"', "&quot;")}"` : "";
    return `<a${kept} class="ai-cite" data-cite="${number}"${label}>${number}</a>`;
  });
}

/** A link whose text is only a citation number; the markdown renderer adds a type or external icon around it. */
const CITATION = /<a\b([^>]*)>(?:<i\b[^>]*><\/i>)?([1-9]\d?)(?:<i\b[^>]*><\/i>)?<\/a>/g;

/** Citations in an answer's Markdown source, in order of first use: `[1](href)`. A number keeps its first destination. */
export const answerCitations = (markdown: string): { number: number; href: string }[] => {
  const citations = new Map<number, string>();
  for (const match of markdown.matchAll(/\[([1-9]\d?)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const number = Number(match[1]);
    const href = match[2]!.replace(/^((?:app|open)\/)/, "/$1");
    if (!citations.has(number)) citations.set(number, href);
  }
  return [...citations].map(([number, href]) => ({ number, href })).sort((a, b) => a.number - b.number);
};
