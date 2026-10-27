import { type CloudCliContext, cliText } from "@k2b/cloud/cli";
import { ANNOTATION_RESULT_MAX_BYTES, type Annotation } from "./lib/annotation-contracts";

// Command paths and help references share this name so the group can be renamed once.
export const ANNOTATION_COMMAND_GROUP = "comments";
export const annotationCommand = (verb: string) => `${ANNOTATION_COMMAND_GROUP} ${verb}`;
export const ANNOTATION_AGENT_HELP = {
  en: "Agents: never accept your own suggestion unless the person explicitly asked you to; propose it as a reply suggestion and let the person accept or reject it.",
  de: "Agents: Eigene Vorschläge nur auf ausdrücklichen Wunsch übernehmen; als Antwortvorschlag hinzufügen und die Person annehmen oder ablehnen lassen.",
};
const timestamp = (iso: string) => iso.slice(0, 16).replace("T", " ");
const provenance = (value: "assistant" | "mcp" | null, ctx: CloudCliContext) =>
  value ? ` · ${cliText(ctx, { en: "via", de: "über" })} ${value === "assistant" ? "Assistant" : "MCP"}` : "";
const suggestionLine = (value: Annotation | Annotation["replies"][number], ctx: CloudCliContext, indent: string) =>
  value.suggestion === null
    ? []
    : [`${indent}${cliText(ctx, { en: "Suggestion", de: "Vorschlag" })} (${value.suggestionState}): ${JSON.stringify(value.suggestion)}`];

export const formatAnnotationReply = (reply: Annotation["replies"][number], ctx: CloudCliContext): string => {
  const lines = [`  ↳ ${reply.id}  ${reply.author.name}${provenance(reply.via, ctx)} · ${timestamp(reply.createdAt)}`];
  if (reply.body) lines.push("    " + reply.body.replaceAll("\n", "\n    "));
  lines.push(...suggestionLine(reply, ctx, "    "));
  if (reply.suggestionStateBy)
    lines.push(
      `    ${reply.suggestionState}: ${reply.suggestionStateBy.name}${provenance(reply.suggestionStateVia, ctx)} · ${timestamp(reply.suggestionStateAt ?? "")}`,
    );
  return lines.join("\n");
};

export const formatAnnotationThread = (item: Annotation, ctx: CloudCliContext): string => {
  const lines = [
    `${item.id}  ${item.state}  ${item.author.name}${provenance(item.via, ctx)} · ${timestamp(item.createdAt)}${item.headingPath.length ? ` · ${item.headingPath.join(" › ")}` : ""}`,
    item.orphan
      ? `  ${cliText(ctx, { en: "ORPHANED: the passage was deleted (was:", de: "VERWAIST: Die Textstelle wurde gelöscht (zuvor:" })} ${JSON.stringify(item.quote)})`
      : `  …${item.prefix}[${item.quote}]${item.suffix}…`,
    ...(item.body ? ["  " + item.body.replaceAll("\n", "\n  ")] : []),
    ...suggestionLine(item, ctx, "  "),
  ];
  if (item.stateBy) lines.push(`  ${item.state}: ${item.stateBy.name}${provenance(item.stateVia, ctx)} · ${timestamp(item.stateAt ?? "")}`);
  if (item.suggestionStateBy)
    lines.push(
      `  ${item.suggestionState}: ${item.suggestionStateBy.name}${provenance(item.suggestionStateVia, ctx)} · ${timestamp(item.suggestionStateAt ?? "")}`,
    );
  for (const reply of item.replies) lines.push(formatAnnotationReply(reply, ctx));
  if (item.repliesNextCursor)
    lines.push(`  ${ANNOTATION_COMMAND_GROUP} list ${item.noteId} --annotation ${item.id} --replies --cursor ${item.repliesNextCursor}`);
  return lines.join("\n");
};

/** Complete normal threads; retain an explicit continuation at the existing response budget. */
export const readAnnotationThread = async (ctx: CloudCliContext, id: string): Promise<Annotation> => {
  const item = await ctx.readJson<Annotation>(await ctx.fetch(`/api/notebooks/annotations/${encodeURIComponent(id)}`));
  const seen = new Set<string>();
  while (item.repliesNextCursor) {
    const cursor = item.repliesNextCursor;
    if (seen.has(cursor))
      throw new Error(cliText(ctx, { en: "Reply pagination did not advance", de: "Die Seitenauswahl der Antworten kommt nicht voran" }));
    seen.add(cursor);
    const page = await ctx.readJson<{ items: Annotation["replies"]; nextCursor: string | null }>(
      await ctx.fetch(
        `/api/notebooks/notes/${encodeURIComponent(item.noteId)}/annotations/${encodeURIComponent(id)}/replies?cursor=${encodeURIComponent(cursor)}`,
      ),
    );
    if (!page.items.length && page.nextCursor)
      throw new Error(cliText(ctx, { en: "Reply pagination did not advance", de: "Die Seitenauswahl der Antworten kommt nicht voran" }));
    const combined = { ...item, replies: [...item.replies, ...page.items], repliesNextCursor: page.nextCursor };
    if (Buffer.byteLength(JSON.stringify(combined), "utf8") > ANNOTATION_RESULT_MAX_BYTES) break;
    item.replies = combined.replies;
    item.repliesNextCursor = page.nextCursor;
  }
  return item;
};
