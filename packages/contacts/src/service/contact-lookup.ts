import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { AccessSubject } from "@k2b/cloud/server";
import { buildAccessPrincipalCondition } from "@k2b/cloud/server";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import type { ContactResolveDataSchema, ContactResolveInputSchema, ContactResolveMatchDataSchema } from "../capability-contracts";

const cursorSchema = z.object({ version: z.literal(1), id: z.uuid() }).strict();
type MatchCursor = z.infer<typeof cursorSchema>;
type ContactResolveInput = z.infer<typeof ContactResolveInputSchema>;
type ContactResolveMatch = Omit<z.infer<typeof ContactResolveMatchDataSchema>, "ref" | "links" | "openHref">;
type ContactResolveData = Omit<z.infer<typeof ContactResolveDataSchema>, "items"> & { items: ContactResolveMatch[] };
type ContactResolvePage = ContactResolveData & { nextCursor: string | null };

type MatchRow = {
  contact_id: string;
  book_id: string;
  book_name: string;
  display_name: string;
  company_name: string | null;
  job_title: string | null;
  matched_emails: string[];
  emails: Array<{ label: string | null; email: string }>;
  phones: Array<{ label: string | null; phone: string }>;
  updated_at: Date;
};

const encodeCursor = (row: MatchRow): string =>
  Buffer.from(JSON.stringify({ version: 1, id: row.contact_id } satisfies MatchCursor)).toString("base64url");

const decodeCursor = (value?: string): Result<MatchCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? ok(parsed.data) : fail(err.badInput("Invalid contact resolution cursor"));
  } catch {
    return fail(err.badInput("Invalid contact resolution cursor"));
  }
};

export const resolveContactsByEmail = async (params: {
  subject: AccessSubject;
  boundBookId: string | null;
  input: ContactResolveInput;
}): Promise<Result<ContactResolvePage>> => {
  const cursor = decodeCursor(params.input.cursor);
  if (!cursor.ok) return cursor;

  const principalMatch = buildAccessPrincipalCondition({
    subject: params.subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const boundBookMatch = params.subject.type === "service_account" ? sql`c.book_id = ${params.boundBookId}::uuid` : sql`true`;
  const emails = toPgTextArray(params.input.emails);
  const contactIds = params.input.contactIds?.length ? toPgUuidArray(params.input.contactIds) : null;
  const limit = params.input.limit;

  const [rows, matchedRows] = await Promise.all([
    sql<MatchRow[]>`
      SELECT
        c.id AS contact_id,
        c.book_id::text AS book_id,
        book.name AS book_name,
        COALESCE(
          NULLIF(BTRIM(c.label), ''),
          NULLIF(BTRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
          NULLIF(BTRIM(c.company_name), ''),
          MIN(match_email.email)
        ) AS display_name,
        NULLIF(BTRIM(c.company_name), '') AS company_name,
        NULLIF(BTRIM(c.job_title), '') AS job_title,
        ARRAY_AGG(DISTINCT LOWER(BTRIM(match_email.email)) ORDER BY LOWER(BTRIM(match_email.email))) AS matched_emails,
        (
          SELECT COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT('label', points.label, 'email', points.email) ORDER BY points.position), '[]'::jsonb)
          FROM (
            SELECT email.label, email.email, email.position
            FROM contacts.contact_emails email
            WHERE email.contact_id = c.id
            ORDER BY email.position, email.id
            LIMIT 21
          ) points
        ) AS emails,
        (
          SELECT COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT('label', points.label, 'phone', points.phone) ORDER BY points.position), '[]'::jsonb)
          FROM (
            SELECT phone.label, phone.phone, phone.position
            FROM contacts.contact_phones phone
            WHERE phone.contact_id = c.id
            ORDER BY phone.position, phone.id
            LIMIT 21
          ) points
        ) AS phones,
        c.updated_at
      FROM contacts.contacts c
      JOIN contacts.contact_emails match_email
        ON match_email.contact_id = c.id
       AND LOWER(BTRIM(match_email.email)) = ANY(${emails}::text[])
      JOIN contacts.books book ON book.id = c.book_id
      JOIN contacts.book_access ba ON ba.book_id = c.book_id
      JOIN auth.access a ON a.id = ba.access_id
      WHERE a.permission IN ('read'::auth.permission_level, 'write'::auth.permission_level, 'admin'::auth.permission_level)
        AND ${principalMatch}
        AND ${boundBookMatch}
        AND (${contactIds}::uuid[] IS NULL OR c.id = ANY(${contactIds}::uuid[]))
        AND (${cursor.data?.id ?? null}::uuid IS NULL OR c.id > ${cursor.data?.id ?? null}::uuid)
      GROUP BY c.id, book.name
      ORDER BY c.id
      LIMIT ${limit + 1}
    `,
    sql<Array<{ email: string }>>`
      SELECT DISTINCT LOWER(BTRIM(match_email.email)) AS email
      FROM contacts.contacts c
      JOIN contacts.contact_emails match_email
        ON match_email.contact_id = c.id
       AND LOWER(BTRIM(match_email.email)) = ANY(${emails}::text[])
      JOIN contacts.book_access ba ON ba.book_id = c.book_id
      JOIN auth.access a ON a.id = ba.access_id
      WHERE a.permission IN ('read'::auth.permission_level, 'write'::auth.permission_level, 'admin'::auth.permission_level)
        AND ${principalMatch}
        AND ${boundBookMatch}
        AND (${contactIds}::uuid[] IS NULL OR c.id = ANY(${contactIds}::uuid[]))
      ORDER BY email
      LIMIT 100
    `,
  ]);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items: ContactResolveMatch[] = page.map((row) => ({
    contactId: row.contact_id,
    bookId: row.book_id,
    bookName: row.book_name,
    displayName: row.display_name,
    companyName: row.company_name,
    jobTitle: row.job_title,
    matchedEmails: row.matched_emails,
    emails: row.emails.slice(0, 20),
    phones: row.phones.slice(0, 20),
    contactPointsTruncated: row.emails.length > 20 || row.phones.length > 20,
    updatedAt: row.updated_at.toISOString(),
  }));
  const last = page.at(-1);
  return ok({ items, matchedEmails: matchedRows.map((row) => row.email), nextCursor: hasMore && last ? encodeCursor(last) : null });
};
