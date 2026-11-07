type SizedMarkdownImage = {
  length: number;
  alt: string;
  href: string;
  hrefFrom: number;
  hrefTo: number;
  title: string | null;
  titleFrom: number | null;
  titleTo: number | null;
  width: number | null;
  height: number | null;
};

/** Parse a leading `![Alt](HREF =WxH)`, `=Wx`, or `=xH`, with an optional quoted title after the size. */
export const parseSizedMarkdownImage = (source: string): SizedMarkdownImage | null => {
  const match = /^!\[([^\]\n]*)\]\(([^\s()]+)[ \t]+=(\d*)x(\d*)(?:[ \t]+("[^"\n]*"))?[ \t]*\)/.exec(source);
  if (!match || (!match[3] && !match[4])) return null;
  const alt = match[1]!;
  const href = match[2]!;
  const hrefFrom = alt.length + 4;
  const hrefTo = hrefFrom + href.length;
  const quotedTitle = match[5];
  const titleFrom = quotedTitle === undefined ? null : match[0].indexOf('"', hrefTo);
  return {
    length: match[0].length,
    alt,
    href,
    hrefFrom,
    hrefTo,
    title: quotedTitle === undefined ? null : quotedTitle.slice(1, -1),
    titleFrom,
    titleTo: titleFrom === null ? null : titleFrom + quotedTitle!.length,
    width: match[3] ? Number(match[3]) : null,
    height: match[4] ? Number(match[4]) : null,
  };
};
