import { sql } from "bun";

/** A release that still assigns missing short IDs at startup; every release from v0.7.0 did. */
const SHORT_ID_BRIDGE_RELEASE = "v0.45.0";

/**
 * Creates the four short-ID tables of a fresh installation in one transaction, so a
 * replica starting at the same time never sees half of them. An existing schema must
 * already have required short IDs: startup does no per-row work and refuses an
 * unfinished database before any other DDL touches it.
 */
const ensureShortIdSchema = async (): Promise<void> => {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.contacts.short-id-schema', 0))`;
    const [state] = await tx<{ fresh: boolean }[]>`
      SELECT to_regclass('contacts.books') IS NULL
        AND to_regclass('contacts.contacts') IS NULL
        AND to_regclass('contacts.contact_notes') IS NULL
        AND to_regclass('contacts.tags') IS NULL AS fresh
    `;
    if (state?.fresh) {
      await tx`
        CREATE TABLE IF NOT EXISTS contacts.books (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          short_id TEXT NOT NULL CONSTRAINT contacts_books_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$')
        )
      `.simple();
      await tx`CREATE UNIQUE INDEX idx_contacts_books_short_id ON contacts.books(short_id)`.simple();
      await tx`
        CREATE TABLE IF NOT EXISTS contacts.contacts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          book_id UUID NOT NULL REFERENCES contacts.books(id) ON DELETE CASCADE,
          label TEXT,
          first_name TEXT,
          last_name TEXT,
          company_name TEXT,
          department TEXT,
          job_title TEXT,
          vat_id TEXT,
          website TEXT,
          birthday DATE,
          note TEXT,
          source TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          short_id TEXT NOT NULL CONSTRAINT contacts_contacts_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$')
        )
      `.simple();
      await tx`CREATE UNIQUE INDEX idx_contacts_contacts_short_id ON contacts.contacts(short_id)`.simple();
      await tx`
        CREATE TABLE IF NOT EXISTS contacts.contact_notes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          contact_id UUID NOT NULL REFERENCES contacts.contacts(id) ON DELETE CASCADE,
          author_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
          author_display_name TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          short_id TEXT NOT NULL CONSTRAINT contacts_notes_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$')
        )
      `.simple();
      await tx`CREATE UNIQUE INDEX idx_contacts_notes_short_id ON contacts.contact_notes(short_id)`.simple();
      await tx`
        CREATE TABLE IF NOT EXISTS contacts.tags (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          book_id UUID NOT NULL REFERENCES contacts.books(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          short_id TEXT NOT NULL CONSTRAINT contacts_tags_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
          UNIQUE (book_id, name)
        )
      `.simple();
      await tx`CREATE UNIQUE INDEX idx_contacts_tags_short_id ON contacts.tags(short_id)`.simple();
      return;
    }

    const [finalized] = await tx<{ ready: boolean }[]>`
      SELECT
        COUNT(*) FILTER (WHERE is_nullable = 'NO') = 4
        AND to_regclass('contacts.idx_contacts_books_short_id') IS NOT NULL
        AND to_regclass('contacts.idx_contacts_contacts_short_id') IS NOT NULL
        AND to_regclass('contacts.idx_contacts_tags_short_id') IS NOT NULL
        AND to_regclass('contacts.idx_contacts_notes_short_id') IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_books_short_id_format')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_contacts_short_id_format')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_tags_short_id_format')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_notes_short_id_format') AS ready
      FROM information_schema.columns
      WHERE table_schema = 'contacts'
        AND table_name IN ('books', 'contacts', 'tags', 'contact_notes')
        AND column_name = 'short_id'
    `;
    if (!finalized?.ready) {
      throw new Error(
        `Contacts cannot start: this database never finished assigning short IDs to books, contacts, tags, and notes. This release no longer does that at startup. Start Contacts once on Cloud ${SHORT_ID_BRIDGE_RELEASE}, which still finishes them, wait until it reports ready, then upgrade to this release. See /en/docs/reference/deprecations-and-migrations#contacts-requires-finished-short-ids`,
      );
    }
  });
};

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS contacts`.simple();
  await ensureShortIdSchema();
  console.log("  ✓ contacts schema");

  console.log("  ✓ contacts.books table");

  await sql`
    CREATE TABLE IF NOT EXISTS contacts.book_access (
      book_id UUID NOT NULL REFERENCES contacts.books(id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (book_id, access_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_book_access_access
    ON contacts.book_access(access_id)
  `.simple();
  console.log("  ✓ contacts.book_access table");

  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contacts_book
    ON contacts.contacts(book_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contacts_book_label
    ON contacts.contacts(book_id, label)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contacts_vat_id
    ON contacts.contacts(vat_id)
    WHERE vat_id IS NOT NULL
  `.simple();
  console.log("  ✓ contacts.contacts table");

  await sql`
    CREATE TABLE IF NOT EXISTS contacts.contact_emails (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id UUID NOT NULL REFERENCES contacts.contacts(id) ON DELETE CASCADE,
      label TEXT,
      email TEXT NOT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contact_id, position)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_emails_contact
    ON contacts.contact_emails(contact_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_emails_normalized
    ON contacts.contact_emails(LOWER(BTRIM(email)), contact_id)
  `.simple();
  console.log("  ✓ contacts.contact_emails table");

  await sql`
    CREATE TABLE IF NOT EXISTS contacts.contact_phones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id UUID NOT NULL REFERENCES contacts.contacts(id) ON DELETE CASCADE,
      label TEXT,
      phone TEXT NOT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contact_id, position)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_phones_contact
    ON contacts.contact_phones(contact_id)
  `.simple();
  console.log("  ✓ contacts.contact_phones table");

  await sql`
    CREATE TABLE IF NOT EXISTS contacts.contact_addresses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id UUID NOT NULL REFERENCES contacts.contacts(id) ON DELETE CASCADE,
      label TEXT,
      recipient_name TEXT,
      company_name TEXT,
      line1 TEXT NOT NULL,
      line2 TEXT,
      postal_code TEXT NOT NULL,
      city TEXT NOT NULL,
      state_region TEXT,
      country_code CHAR(2) NOT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contact_id, position)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_addresses_contact
    ON contacts.contact_addresses(contact_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_addresses_postal
    ON contacts.contact_addresses(postal_code, city)
  `.simple();
  // Location of the address text in geo_hash: found (point and provenance) or not found (point null).
  // A changed address never matches its old hash, so it is looked up again.
  await sql`
    ALTER TABLE contacts.contact_addresses
      ADD COLUMN IF NOT EXISTS geo_hash TEXT,
      ADD COLUMN IF NOT EXISTS geo_lat DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS geo_lon DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS geo_provenance JSONB,
      ADD COLUMN IF NOT EXISTS geo_checked_at TIMESTAMPTZ
  `.simple();
  console.log("  ✓ contacts.contact_addresses table");

  // Hierarchy: parent_contact_id introduced after initial release. ON DELETE SET NULL
  // keeps children intact when a parent is deleted; cycles are prevented at the
  // service layer via a recursive CTE check, not in the schema.
  await sql`
    ALTER TABLE contacts.contacts
    ADD COLUMN IF NOT EXISTS parent_contact_id UUID NULL
    REFERENCES contacts.contacts(id) ON DELETE SET NULL
  `.simple();
  await sql`ALTER TABLE contacts.contacts ADD COLUMN IF NOT EXISTS salutation TEXT`.simple();
  await sql`ALTER TABLE contacts.contacts ADD COLUMN IF NOT EXISTS pronouns TEXT`.simple();
  await sql`ALTER TABLE contacts.contacts ADD COLUMN IF NOT EXISTS preferred_language TEXT`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contacts_parent
    ON contacts.contacts(parent_contact_id)
    WHERE parent_contact_id IS NOT NULL
  `.simple();
  console.log("  ✓ contacts.contacts personal columns + parent_contact_id index");

  // Notes timeline replaces the legacy single `note` column. The column is
  // dropped here — no data migration since the feature was unused in production.
  await sql`ALTER TABLE contacts.contacts DROP COLUMN IF EXISTS note`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_notes_contact_created
    ON contacts.contact_notes(contact_id, created_at DESC)
  `.simple();
  console.log("  ✓ contacts.contact_notes table");

  // Tags scoped per book — vocabulary stays separated between e.g. customers
  // and suppliers. Junction is composite PK (one row per tag per contact).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_tags_book
    ON contacts.tags(book_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS contacts.contact_tag_assignments (
      contact_id UUID NOT NULL REFERENCES contacts.contacts(id) ON DELETE CASCADE,
      tag_id UUID NOT NULL REFERENCES contacts.tags(id) ON DELETE CASCADE,
      PRIMARY KEY (contact_id, tag_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_tag_assignments_tag
    ON contacts.contact_tag_assignments(tag_id)
  `.simple();
  console.log("  ✓ contacts.tags + contact_tag_assignments tables");

  // Multiple websites per contact (label + url) replace the legacy single
  // `website` column. Schema break — no data carried over since the feature
  // was not in production use.
  await sql`
    CREATE TABLE IF NOT EXISTS contacts.contact_websites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id UUID NOT NULL REFERENCES contacts.contacts(id) ON DELETE CASCADE,
      label TEXT,
      url TEXT NOT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contact_id, position)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_websites_contact
    ON contacts.contact_websites(contact_id)
  `.simple();
  await sql`ALTER TABLE contacts.contacts DROP COLUMN IF EXISTS website`.simple();
  console.log("  ✓ contacts.contact_websites table");

  await sql`
    CREATE TABLE IF NOT EXISTS contacts.contact_bank_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id UUID NOT NULL REFERENCES contacts.contacts(id) ON DELETE CASCADE,
      label TEXT,
      account_holder_name TEXT NOT NULL,
      iban TEXT NOT NULL,
      bic TEXT,
      bank_name TEXT,
      note TEXT,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (contact_id, position)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_bank_accounts_contact
    ON contacts.contact_bank_accounts(contact_id)
  `.simple();
  console.log("  ✓ contacts.contact_bank_accounts table");

  // Favorites are personal UI state. `book_id` remains text for compatibility
  // with the existing table shape, but Contacts now stores only book UUIDs.
  await sql`
    CREATE TABLE IF NOT EXISTS contacts.contact_favorites (
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL,
      contact_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, book_id, contact_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_favorites_user_created
    ON contacts.contact_favorites(user_id, created_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_contact_favorites_book_contact
    ON contacts.contact_favorites(book_id, contact_id)
  `.simple();
  console.log("  ✓ contacts.contact_favorites table");

  await sql`
    CREATE TABLE IF NOT EXISTS contacts.capability_action_results (
      actor_key TEXT NOT NULL,
      action_id TEXT NOT NULL,
      idempotency_key_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      -- Keep replay records even when a user later deletes the created contact.
      contact_id UUID NOT NULL,
      result_label TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (actor_key, action_id, idempotency_key_hash)
    )
  `.simple();
  await sql`
    ALTER TABLE contacts.capability_action_results
    ADD COLUMN IF NOT EXISTS result_label TEXT
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_capability_action_results_created
    ON contacts.capability_action_results(created_at)
  `.simple();
  console.log("  ✓ contacts.capability_action_results table");

  // The former virtual IPA book was never durable Contacts data. Remove only
  // its stale personal UI references; auth-owned users remain untouched.
  await sql`DELETE FROM contacts.contact_favorites WHERE book_id = 'system'`.simple();
};
