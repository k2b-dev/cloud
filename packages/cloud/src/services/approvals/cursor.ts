import { z } from "zod";

const CursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();
type ApprovalCursor = z.infer<typeof CursorSchema>;

export const encodeApprovalCursor = (cursor: ApprovalCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");
export const decodeApprovalCursor = (cursor: string): ApprovalCursor | null => {
  try {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
