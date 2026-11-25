import { topicFiles as files } from "./topic-files";
import { type ParsedTopic, parseTopic, topicMarkdown, topicParts, topicSummary } from "./topic-markdown";

export type Topic = {
  slug: string;
  number: number;
  path: string;
  href: string;
  parsed: ParsedTopic;
  /** The first sentence of the lead. */
  summary: string;
  parts: string[];
  /** The Markdown twin for search, `read_doc` and llms.txt. */
  markdown: string;
};

export const topics: readonly Topic[] = files.map(([slug, source], index) => {
  const parsed = parseTopic(source);
  return {
    slug,
    number: index + 1,
    path: `/v2/${slug}`,
    href: `/en/ui/v2/${slug}`,
    parsed,
    summary: topicSummary(parsed),
    parts: topicParts(parsed),
    markdown: topicMarkdown(source),
  };
});

/** The raw files, for the shape test. */
export { topicFiles } from "./topic-files";
