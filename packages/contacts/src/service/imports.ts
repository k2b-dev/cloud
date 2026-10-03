import { logger } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { create as createContact } from "./contacts";
import { publishContactChange } from "./live";
import type { CreateContactInput } from "./types";
import * as vcard from "./vcard";

const log = logger("contacts:import");

export const MAX_IMPORT_CONTACTS = 1_000;
export const MAX_IMPORT_CONTENT_CHARS = 10_000_000;
export const MAX_IMPORT_BODY_BYTES = 12_000_000;

type ImportCandidate = ReturnType<typeof vcard.parse>[number];
type ImportMatch = { existingId: string; existingName: string } | null;
type ImportMatchHit = { id: string; name: string };
type ImportMatchIndex = {
  email: Map<string, ImportMatchHit>;
  name: Map<string, ImportMatchHit>;
};

const loadMatchIndex = async (bookId: string): Promise<ImportMatchIndex> => {
  const rows = await sql<{ id: string; first_name: string | null; last_name: string | null; label: string | null; emails: string[] }[]>`
    SELECT
      c.short_id AS id,
      c.first_name,
      c.last_name,
      c.label,
      COALESCE(
        (SELECT array_agg(LOWER(ce.email)) FROM contacts.contact_emails ce WHERE ce.contact_id = c.id),
        '{}'::text[]
      ) AS emails
    FROM contacts.contacts c
    WHERE c.book_id = ${bookId}::uuid
  `;

  const email = new Map<string, ImportMatchHit>();
  const name = new Map<string, ImportMatchHit>();
  for (const row of rows) {
    const display = [row.first_name, row.last_name].filter(Boolean).join(" ") || row.label || row.id;
    for (const address of row.emails) {
      if (address) email.set(address, { id: row.id, name: display });
    }
    const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim().toLowerCase();
    if (fullName) name.set(fullName, { id: row.id, name: display });
  }

  return { email, name };
};

const findMatch = (candidate: ImportCandidate, index: ImportMatchIndex): ImportMatch => {
  for (const email of candidate.emails ?? []) {
    const hit = index.email.get(email.email.toLowerCase());
    if (hit) return { existingId: hit.id, existingName: hit.name };
  }

  const fullName = [candidate.firstName, candidate.lastName].filter(Boolean).join(" ").trim().toLowerCase();
  const hit = fullName ? index.name.get(fullName) : null;
  return hit ? { existingId: hit.id, existingName: hit.name } : null;
};

export const preview = async (config: {
  bookId: string;
  content: string;
}): Promise<Result<{ candidates: { candidate: ImportCandidate; match: ImportMatch }[] }>> => {
  const candidates = vcard.parse(config.content);
  if (candidates.length > MAX_IMPORT_CONTACTS) {
    return fail(err.badInput(`Import is limited to ${MAX_IMPORT_CONTACTS} contacts at a time`));
  }

  const index = await loadMatchIndex(config.bookId);
  return ok({
    candidates: candidates.map((candidate) => ({
      candidate,
      match: findMatch(candidate, index),
    })),
  });
};

export const commit = async (config: {
  bookId: string;
  candidates: unknown[];
  validateCandidate: (candidate: unknown) => Result<CreateContactInput>;
}): Promise<{ created: number; failures: string[] }> => {
  let created = 0;
  const failures: string[] = [];

  try {
    for (const candidate of config.candidates) {
      const parsed = config.validateCandidate(candidate);
      if (!parsed.ok) {
        failures.push(parsed.error.message);
        continue;
      }

      const result = await createContact({ bookId: config.bookId, data: parsed.data, announce: false });
      if (result.ok) created++;
      else failures.push(result.error.message);
    }
  } finally {
    // Each create commits on its own, so the import's one update follows them, even when a
    // later candidate throws. A process stop before it loses the update; open tabs show the
    // imported contacts after their next reload.
    if (created > 0) await announceImport(config.bookId);
  }
  return { created, failures };
};

/** The contacts are committed: a failed update must not turn the import into an error. */
const announceImport = async (bookId: string): Promise<void> => {
  try {
    await sql.begin((tx) => publishContactChange(tx, { type: "contacts.imported", bookId }));
  } catch (error) {
    log.warn("Failed to write the Contacts import update", { bookId, error: error instanceof Error ? error.message : String(error) });
  }
};
