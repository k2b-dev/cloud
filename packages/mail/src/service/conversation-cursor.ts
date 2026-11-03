import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import { type ConversationView, type ConversationWorkStatus, conversationViewSchema, conversationWorkStatusSchema } from "../contracts";

export type ConversationCursorScope = {
  mailboxId: string;
  folderId: string | null;
  excludedFolderIds: string[];
  status: ConversationWorkStatus | null;
  view: ConversationView | null;
  unread: boolean | null;
  userId: string | null;
  /** The list left out done and snoozed conversations; a page of the other list cannot continue it. */
  openOnly: boolean;
};

/** "Assigned to me" lists whose turn it is first; its cursor names the group the page ended in. */
export type ConversationCursorGroup = "needs_action" | "waiting";

type ConversationCursor = {
  version: 4;
  scope: ConversationCursorScope;
  date: string;
  id: string;
  group?: ConversationCursorGroup;
};

const conversationCursorSchema = z.object({
  version: z.literal(4),
  scope: z.object({
    mailboxId: z.uuid(),
    folderId: z.uuid().nullable(),
    excludedFolderIds: z.array(z.uuid()),
    status: conversationWorkStatusSchema.nullable(),
    view: conversationViewSchema.nullable(),
    unread: z.boolean().nullable(),
    userId: z.uuid().nullable(),
    openOnly: z.boolean().default(false),
  }),
  date: z.iso.datetime({ offset: true }),
  id: z.uuid(),
  group: z.enum(["needs_action", "waiting"]).optional(),
});

const sameScope = (left: ConversationCursorScope, right: ConversationCursorScope): boolean =>
  left.mailboxId === right.mailboxId &&
  left.folderId === right.folderId &&
  left.excludedFolderIds.length === right.excludedFolderIds.length &&
  left.excludedFolderIds.every((id, index) => id === right.excludedFolderIds[index]) &&
  left.status === right.status &&
  left.view === right.view &&
  left.unread === right.unread &&
  left.userId === right.userId &&
  left.openOnly === right.openOnly;

export const encodeConversationCursor = (cursor: Omit<ConversationCursor, "version">): string =>
  Buffer.from(JSON.stringify({ version: 4, ...cursor })).toString("base64url");

export const decodeConversationCursor = (
  value: string | undefined,
  expectedScope: ConversationCursorScope,
): Result<ConversationCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = conversationCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (!parsed.success || !sameScope(parsed.data.scope, expectedScope)) {
      return fail(err.badInput("Invalid pagination cursor"));
    }
    return ok(parsed.data);
  } catch {
    return fail(err.badInput("Invalid pagination cursor"));
  }
};
