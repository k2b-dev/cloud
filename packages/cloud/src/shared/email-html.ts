import sanitizeHtml from "sanitize-html";

export const EMAIL_HTML_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "div",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

export const EMAIL_HTML_ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "target", "style"],
  blockquote: ["style"],
  div: ["style"],
  h1: ["style"],
  h2: ["style"],
  h3: ["style"],
  hr: ["style"],
  li: ["style"],
  ol: ["style"],
  p: ["style"],
  pre: ["style"],
  span: ["style"],
  table: ["style", "cellpadding", "cellspacing", "width", "align", "border"],
  tbody: ["style"],
  td: ["style", "width", "align", "valign", "colspan", "rowspan"],
  tfoot: ["style"],
  th: ["style", "width", "align", "valign", "colspan", "rowspan"],
  thead: ["style"],
  tr: ["style"],
  ul: ["style"],
};

export const EMAIL_HTML_ALLOWED_SCHEMES = ["http", "https", "mailto", "tel"] as const;

// An optional leading `+`, at least one digit, the visual separators of RFC 3966 and spaces, and an optional extension.
const PHONE_NUMBER_HREF = /^tel:\+?(?=[^;]*\d)[\d\-.() ]+(?:;ext=\d+)?$/i;

/** Whether a `tel:` link holds a phone number, such as `tel:+49 731 000000` or `tel:+49-731-000000;ext=12`. */
const isPhoneNumberHref = (href: string): boolean => {
  try {
    return PHONE_NUMBER_HREF.test(decodeURI(href.trim()));
  } catch {
    return false;
  }
};

// Like sanitize-html, ignore control characters and whitespace when reading the scheme.
const hrefScheme = (href: string): string | undefined =>
  href
    .replace(/[\u0000-\u0020]+/g, "")
    .match(/^([a-z][a-z\d+.-]*):/i)?.[1]
    ?.toLowerCase();

/**
 * Drops a `tel:` link that holds no phone number; its text stays. sanitize-html removes HTML comments before
 * it reads a scheme, so a link address with a comment, such as `te<!---->l:`, is dropped too.
 */
const keepPhoneNumberHref: sanitizeHtml.Transformer = (tagName, attribs) => {
  const href = attribs.href;
  if (href === undefined || (!href.includes("<!--") && (hrefScheme(href) !== "tel" || isPhoneNumberHref(href)))) {
    return { tagName, attribs };
  }
  const { href: _dropped, ...kept } = attribs;
  return { tagName, attribs: kept };
};

/** The sanitize-html options of the email sanitizer. Extend them instead of repeating the allowlists. */
export const EMAIL_HTML_SANITIZE_OPTIONS = {
  allowedTags: [...EMAIL_HTML_TAGS],
  allowedAttributes: EMAIL_HTML_ALLOWED_ATTRIBUTES,
  allowedSchemes: [...EMAIL_HTML_ALLOWED_SCHEMES],
  transformTags: { a: keepPhoneNumberHref },
} satisfies sanitizeHtml.IOptions;

export const sanitizeEmailHtml = (html: string): string => sanitizeHtml(html, EMAIL_HTML_SANITIZE_OPTIONS);
