import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const PayloadSchema = z
  .object({
    appId: z.string().uuid(),
    publishedAt: z.string().datetime(),
    pageId: z.string(),
    blockId: z.string(),
    pageParams: z.record(z.string(), z.string().uuid()),
    viewerUserId: z.string().uuid().nullable(),
    viewerServiceAccountId: z.string().uuid().nullable(),
    search: z.string().nullable(),
    cursor: z.string().nullable(),
    tableId: z.string().uuid(),
    recordId: z.string().uuid(),
    fieldId: z.string().uuid(),
    fileId: z.string().uuid(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type CustomAppFileTokenPayload = z.infer<typeof PayloadSchema>;

const sameStringRecord = (left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean => {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
};

export const customAppFileTokenMatchesContext = (
  token: CustomAppFileTokenPayload,
  context: Pick<
    CustomAppFileTokenPayload,
    "appId" | "publishedAt" | "pageId" | "blockId" | "pageParams" | "viewerUserId" | "viewerServiceAccountId"
  >,
): boolean =>
  token.appId === context.appId &&
  token.publishedAt === context.publishedAt &&
  token.pageId === context.pageId &&
  token.blockId === context.blockId &&
  token.viewerUserId === context.viewerUserId &&
  token.viewerServiceAccountId === context.viewerServiceAccountId &&
  sameStringRecord(token.pageParams, context.pageParams);

const signature = (encoded: string, secret: string): string => createHmac("sha256", secret).update(encoded).digest("base64url");

export const createCustomAppFileToken = (
  payload: Omit<CustomAppFileTokenPayload, "expiresAt">,
  secret: string,
  now = Date.now(),
): string => {
  const encoded = Buffer.from(JSON.stringify({ ...payload, expiresAt: now + 5 * 60_000 }), "utf8").toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
};

export const verifyCustomAppFileToken = (token: string, secret: string, now = Date.now()): CustomAppFileTokenPayload | null => {
  const [encoded, supplied, extra] = token.split(".");
  if (!encoded || !supplied || extra) return null;
  const expected = signature(encoded, secret);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) return null;
  try {
    const parsed = PayloadSchema.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    return parsed.success && parsed.data.expiresAt >= now ? parsed.data : null;
  } catch {
    return null;
  }
};
