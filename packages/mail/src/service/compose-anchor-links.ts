type Link = { label: string; destination: string };

const anchorLabel = (body: string): string => {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf("<", cursor);
    if (start < 0) break;
    if (body[start + 1] === ">") {
      parts.push(body.slice(cursor, start + 2));
      cursor = start + 2;
      continue;
    }
    const end = body.indexOf(">", start + 2);
    if (end < 0) break;
    parts.push(body.slice(cursor, start));
    cursor = end + 1;
  }
  parts.push(body.slice(cursor));
  return parts.join("").trim();
};

/** Preserve the compose check's anchor matching, including its last quoted href.
 * Every search cursor moves forward, including on malformed, nested openings. */
export const composeAnchorLinks = (body: string): Link[] => {
  const hrefs: Array<{ start: number; labelStart: number; closeStart: number; end: number; destination: string }> = [];
  const attributes = /\bhref\s*=\s*["']([^"']+)["']/gi;
  const closing = /<\/a>/gi;
  let tagEnd = -1;
  let close: RegExpExecArray | null = null;
  for (let attribute = attributes.exec(body); attribute; attribute = attributes.exec(body)) {
    const valueEnd = attributes.lastIndex;
    // A quoted value may itself contain another href. Do not skip that start.
    attributes.lastIndex = attribute.index + 4;
    if (tagEnd < valueEnd) tagEnd = body.indexOf(">", valueEnd);
    if (tagEnd < 0) break;
    while (!close || close.index <= tagEnd) {
      close = closing.exec(body);
      if (!close) return matchAnchors(body, hrefs);
    }
    hrefs.push({
      start: attribute.index,
      labelStart: tagEnd + 1,
      closeStart: close.index,
      end: close.index + close[0].length,
      destination: attribute[1]!,
    });
  }
  return matchAnchors(body, hrefs);
};

const matchAnchors = (
  body: string,
  hrefs: Array<{ start: number; labelStart: number; closeStart: number; end: number; destination: string }>,
): Link[] => {
  const links: Link[] = [];
  const openings = /<a\b/gi;
  let hrefIndex = 0;
  let tagEnd = -1;
  for (let opening = openings.exec(body); opening; opening = openings.exec(body)) {
    const start = openings.lastIndex;
    if (tagEnd < start) tagEnd = body.indexOf(">", start);
    if (tagEnd < 0) break;
    while (hrefIndex < hrefs.length && hrefs[hrefIndex]!.start < tagEnd) hrefIndex++;
    const href = hrefs[hrefIndex - 1];
    if (!href || href.start < start) continue;
    links.push({ label: anchorLabel(body.slice(href.labelStart, href.closeStart)), destination: href.destination });
    openings.lastIndex = href.end;
  }
  return links;
};
