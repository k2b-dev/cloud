/** Templates are small reusable documents, not another bulk file store. */
export const TEMPLATE_LIMIT = 20 * 1024 * 1024;
/** Matches the existing text-preview budget. */
export const MARKDOWN_LIMIT = 2 * 1024 * 1024;
export const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);
export const markdownRevision = (node: { revision?: string; modified: string; size: number }) =>
  node.revision ?? `fs:${node.modified}:${node.size}`;
