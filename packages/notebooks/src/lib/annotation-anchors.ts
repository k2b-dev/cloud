import { SHARED_TEXT_NAME } from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import { ANNOTATION_CONTEXT_LENGTH } from "./annotation-contracts";

type Selector = { quote: string; prefix: string; suffix: string };
export const annotationPositions = (doc: Y.Doc, from: number, to: number) => {
  const text = doc.getText(SHARED_TEXT_NAME);
  return {
    start: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    end: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, to, -1)),
  };
};
export const absoluteAnnotationPosition = (doc: Y.Doc, position: Uint8Array): number | null => {
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(position), doc, false);
    return absolute?.type === doc.getText(SHARED_TEXT_NAME) ? absolute.index : null;
  } catch {
    return null;
  }
};
const matches = (text: string, from: number, selector: Selector) =>
  text.slice(from, from + selector.quote.length) === selector.quote &&
  text.slice(Math.max(0, from - selector.prefix.length), from) === selector.prefix &&
  text.slice(from + selector.quote.length, from + selector.quote.length + selector.suffix.length) === selector.suffix;

/** Creation may use a caller's precise offset; recovery always requires unique context. */
export const locateAnnotation = (text: string, selector: Selector, offsetHint?: number): number | null => {
  if (offsetHint !== undefined && offsetHint <= text.length && matches(text, offsetHint, selector)) return offsetHint;
  const needle = selector.prefix + selector.quote + selector.suffix;
  const match = text.indexOf(needle);
  if (match < 0 || text.indexOf(needle, match + 1) >= 0) return null;
  return match + selector.prefix.length;
};
export const resolveAnnotation = (config: {
  doc: Y.Doc;
  start: Uint8Array;
  end: Uint8Array;
  selector: Selector;
  sameRevision: boolean;
}) => {
  const from = absoluteAnnotationPosition(config.doc, config.start);
  const to = absoluteAnnotationPosition(config.doc, config.end);
  const text = config.doc.getText(SHARED_TEXT_NAME).toString();
  if (config.sameRevision && from !== null && to !== null && from < to) return { from, to, orphan: false, reanchored: false };
  // Require all available W3C context (at least one side), and keep recovery
  // within one context window of the collapsed dot. Quote-only recovery is unsafe.
  const selector = config.selector;
  const strong = selector.prefix.length > 0 || selector.suffix.length > 0;
  const found = strong ? locateAnnotation(text, selector) : null;
  const nearby = from === null || Math.abs((found ?? Infinity) - from) <= ANNOTATION_CONTEXT_LENGTH;
  if (found !== null && nearby) return { from: found, to: found + selector.quote.length, orphan: false, reanchored: true };
  const dot = Math.min(from ?? 0, text.length);
  return { from: dot, to: dot, orphan: true, reanchored: false };
};

/** Heading labels at the source offset; fenced code cannot create headings. */
export const annotationHeadingPath = (text: string, offset: number): string[] => {
  const headings: Array<{ level: number; text: string }> = [];
  let fence: string | null = null;
  for (const line of text.slice(0, offset).split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (!match) continue;
    const level = match[1]!.length;
    while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
    headings.push({ level, text: match[2]! });
  }
  return headings.map((heading) => heading.text);
};
