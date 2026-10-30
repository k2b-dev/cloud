import { literalMarkdownLines } from "./markdown-context";

export type Directive = {
  type: "query" | "toc" | "chart" | "map";
  body: string[];
  line: number;
  closed: boolean;
  from: number;
  to: number;
};

export const directives = (md: string): Directive[] => {
  if (!/:::(?:query|toc|chart|map)\b/.test(md)) return [];
  const lines = md.split("\n");
  const literalLines = literalMarkdownLines(md);
  const offsets: number[] = [];
  let offset = 0;
  for (const text of lines) {
    offsets.push(offset);
    offset += text.length + 1;
  }
  const found: Directive[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (literalLines.has(i)) continue;
    const text = lines[i]!;
    const opener = text.match(/^ {0,3}:::(query|toc|chart|map)[ \t]*\r?$/);
    if (!opener?.[1]) continue;
    const line = i + 1;
    const body: string[] = [];
    let closed = false;
    for (i = i + 1; i < lines.length; i++) {
      if (/^ {0,3}:::[ \t]*\r?$/.test(lines[i]!)) {
        closed = true;
        break;
      }
      // Keep raw offsets above; normalize only the body consumed by the DSL.
      body.push(lines[i]!.replace(/\r$/, ""));
    }
    found.push({
      type: opener[1] as Directive["type"],
      body,
      line,
      closed,
      from: offsets[line - 1]!,
      to: closed ? offsets[i]! + lines[i]!.length : md.length,
    });
  }
  return found;
};

/** Source geometry only; query validation and result rendering stay server-owned. */
export const extractNotebookDirectiveRanges = (md: string): Array<Pick<Directive, "type" | "line" | "from" | "to" | "closed">> =>
  directives(md).map(({ type, line, from, to, closed }) => ({ type, line, from, to, closed }));
