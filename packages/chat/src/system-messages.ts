import { Marked, type Token, type Tokens } from "marked";
import { chatMessages } from "./messages";
import type { AttachmentView, SystemMessage } from "./service/contracts";

export const renderSystemMessage = (system: SystemMessage, authorName: string, locale?: string): string => {
  const resolved = chatMessages.resolve(locale ? [locale] : []);
  const t = resolved.t;
  const actor = authorName;
  switch (system.code) {
    case "thread_created":
      return t.systemThreadCreated({ actor, name: system.params.thread.name });
    case "thread_renamed":
      return t.systemThreadRenamed({ actor, from: system.params.from, to: system.params.to });
    case "discovery_changed":
      return system.params.count ? t.systemDiscoveryChanged({ actor }) : t.systemDiscoveryRemoved({ actor });
    case "conversation_created":
      return t.systemCreated({ actor });
    case "details_changed": {
      const { name, icon, purpose } = system.params;
      if (name === undefined) return t.systemDetails({ actor });
      const details = icon !== undefined || purpose !== undefined;
      if (name === null) return details ? t.systemNameRemovedWithDetails({ actor }) : t.systemNameRemoved({ actor });
      return details ? t.systemRenamedWithDetails({ actor, name }) : t.systemRenamed({ actor, name });
    }
    case "members_added":
    case "groups_added": {
      const members = system.code === "members_added" ? system.params.members : system.params.groups;
      // A fourth name reads better than "and 1 others", so only five or more members are counted.
      const shown = members.length > 4 ? 3 : members.length;
      const names = members.slice(0, shown).map((member) => member.name);
      if (members.length > shown) names.push(t.systemOthers({ count: members.length - shown }));
      const formatted = new Intl.ListFormat(resolved.locale, { style: "long", type: "conjunction" }).format(names);
      return system.code === "members_added"
        ? t.systemAdded({ actor, names: formatted })
        : t.systemGroupsAdded({ actor, names: formatted, count: members.length });
    }
    case "group_removed":
      return t.systemGroupRemoved({ actor, name: system.params.group.name });
    case "manager_assigned":
      return t.systemManagerAssigned({ name: system.params.member.name });
    case "member_removed":
      return t.systemRemoved({ actor, name: system.params.member.name });
    case "member_left":
      return system.params.successor ? t.systemSuccessor({ actor, name: system.params.successor.name }) : t.systemLeft({ actor });
    case "permission_changed": {
      const permission =
        system.params.permission === "read"
          ? t.permissionRead
          : system.params.permission === "write"
            ? t.permissionWrite
            : t.permissionManage;
      return t.systemPermission({ actor, name: system.params.member.name, permission });
    }
  }
};

// The same Markdown the message renders with, so the preview reads what the message shows.
const markdown = new Marked({ gfm: true, breaks: true });
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (!name.startsWith("#")) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });

/**
 * Visible text of Markdown tokens: emphasis, link and code text, image alt text, list items and table cells. Blocks are
 * joined with a space, inline parts without one, so "a**b**" stays one word.
 */
const visibleText = (tokens: readonly Token[], separator: "" | " "): string =>
  tokens
    .map((token): string => {
      if (token.type === "list") return (token as Tokens.List).items.map((item) => visibleText(item.tokens, " ")).join(" ");
      if (token.type === "table") {
        const table = token as Tokens.Table;
        return [table.header, ...table.rows].map((row) => row.map((cell) => visibleText(cell.tokens, "")).join(" ")).join(" ");
      }
      if (token.type === "checkbox") return "";
      if ("tokens" in token && token.tokens) return visibleText(token.tokens, token.type === "blockquote" ? " " : "");
      if (token.type === "br" || token.type === "space" || token.type === "hr") return " ";
      return "text" in token && typeof token.text === "string" ? token.text : "";
    })
    .join(separator);

/** A message as one line of plain text: what a reader sees, without Markdown marks. */
export const messagePlainText = (body: string): string => {
  let text: string;
  try {
    text = decodeEntities(visibleText(markdown.lexer(body), " "));
  } catch {
    text = body;
  }
  return text.replace(/\s+/gu, " ").trim();
};

export const messagePreview = (
  body: string,
  attachments: readonly Pick<AttachmentView, "kind" | "name">[] = [],
  locale?: string,
): string => {
  const text = messagePlainText(body);
  const first = attachments[0];
  let preview = text;
  if (!preview && first) {
    const t = chatMessages.resolve(locale ? [locale] : []).t;
    preview = first.kind === "image" ? t.attachmentPhoto : t.attachmentFile({ name: first.name });
  }
  return [...preview].slice(0, 140).join("");
};
