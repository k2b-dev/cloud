import { appEvents } from "@k2b/cloud/events";
import { toPgUuidArray } from "@k2b/cloud/services";
import type { SQL } from "bun";
import { z } from "zod";
import type { contactsCapabilities } from "./capabilities";

export const CONTACT_FIELD_GROUPS = [
  "profile",
  "emails",
  "phones",
  "addresses",
  "websites",
  "bankAccounts",
  "tags",
  "notes",
  "parent",
  "book",
] as const;
export type ContactFieldGroup = (typeof CONTACT_FIELD_GROUPS)[number];
export const contactsEvents = {
  "contact.created": {
    version: 1,
    title: "Contact created",
    description: "A contact was created in an address book.",
    subject: "contact",
    place: "book",
    schema: z.strictObject({}),
  },
  "contact.updated": {
    version: 1,
    title: "Contact updated",
    description: "An existing contact's field groups changed.",
    subject: "contact",
    place: "book",
    schema: z.strictObject({ changed: z.array(z.enum(CONTACT_FIELD_GROUPS)).min(1).max(CONTACT_FIELD_GROUPS.length) }),
  },
} as const;
const publisher = appEvents<typeof contactsCapabilities>("contacts");

export const publishContactsEvent = async (
  tx: SQL,
  name: keyof typeof contactsEvents,
  subject: string,
  place: string,
  changed?: ContactFieldGroup[],
): Promise<void> => {
  await publisher.publish(tx, name, { subject, place, data: name === "contact.updated" ? { changed: changed ?? [] } : {} });
};

export const publishContactCreated = async (tx: SQL, id: string): Promise<void> => {
  const [ref] = await tx<{ subject: string; place: string }[]>`
    SELECT c.short_id AS subject, b.short_id AS place FROM contacts.contacts c JOIN contacts.books b ON b.id = c.book_id WHERE c.id = ${id}::uuid`;
  if (!ref) throw new Error("Contact event names a missing contact");
  await publishContactsEvent(tx, "contact.created", ref.subject, ref.place);
};

export type ContactEventState = { id: string; subject: string; place: string; groups: Record<ContactFieldGroup, string> };

/** Serialize writers on the contact; compare values, ignoring regenerated row IDs and timestamps. */
export const contactEventStates = async (tx: SQL, ids: string[]): Promise<ContactEventState[]> => {
  if (!ids.length) return [];
  await tx`SELECT id FROM contacts.contacts WHERE id = ANY(${toPgUuidArray(ids)}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
  return tx<ContactEventState[]>`
    SELECT c.id, c.short_id AS subject, b.short_id AS place, jsonb_build_object(
      'profile', (to_jsonb(c) - ARRAY['id','short_id','book_id','parent_contact_id','created_at','updated_at'])::text,
      'parent', COALESCE(c.parent_contact_id::text, ''), 'book', c.book_id::text,
      'emails', COALESCE((SELECT jsonb_agg(to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'] ORDER BY (to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'])) FROM contacts.contact_emails v WHERE v.contact_id = c.id), '[]'::jsonb)::text,
      'phones', COALESCE((SELECT jsonb_agg(to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'] ORDER BY (to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'])) FROM contacts.contact_phones v WHERE v.contact_id = c.id), '[]'::jsonb)::text,
      'addresses', COALESCE((SELECT jsonb_agg(to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at','geo_hash','geo_lat','geo_lon','geo_provenance','geo_checked_at','geo_lookup_at','geo_lookup_hash'] ORDER BY (to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at','geo_hash','geo_lat','geo_lon','geo_provenance','geo_checked_at','geo_lookup_at','geo_lookup_hash'])) FROM contacts.contact_addresses v WHERE v.contact_id = c.id), '[]'::jsonb)::text,
      'websites', COALESCE((SELECT jsonb_agg(to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'] ORDER BY (to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'])) FROM contacts.contact_websites v WHERE v.contact_id = c.id), '[]'::jsonb)::text,
      'bankAccounts', COALESCE((SELECT jsonb_agg(to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'] ORDER BY (to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'])) FROM contacts.contact_bank_accounts v WHERE v.contact_id = c.id), '[]'::jsonb)::text,
      'tags', COALESCE((SELECT jsonb_agg(to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'] ORDER BY (to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'])) FROM contacts.contact_tag_assignments v WHERE v.contact_id = c.id), '[]'::jsonb)::text,
      'notes', COALESCE((SELECT jsonb_agg(to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'] ORDER BY (to_jsonb(v) - ARRAY['id','short_id','contact_id','created_at','updated_at'])) FROM contacts.contact_notes v WHERE v.contact_id = c.id), '[]'::jsonb)::text
    ) AS groups FROM contacts.contacts c JOIN contacts.books b ON b.id = c.book_id WHERE c.id = ANY(${toPgUuidArray(ids)}::uuid[]) ORDER BY c.id`;
};

export const contactEventState = async (tx: SQL, id: string): Promise<ContactEventState | undefined> =>
  (await contactEventStates(tx, [id]))[0];

/** Bulk writes read the selected set together, avoiding per-contact comparison queries. */
export const publishContactsUpdated = async (tx: SQL, before: ContactEventState[]): Promise<void> => {
  const after = new Map(
    (
      await contactEventStates(
        tx,
        before.map((state) => state.id),
      )
    ).map((state) => [state.id, state]),
  );
  for (const previous of before) {
    const current = after.get(previous.id);
    if (!current) continue;
    const changed = CONTACT_FIELD_GROUPS.filter((group) => previous.groups[group] !== current.groups[group]);
    if (changed.length) await publishContactsEvent(tx, "contact.updated", current.subject, current.place, changed);
  }
};

export const publishContactUpdated = async (tx: SQL, before: ContactEventState | undefined): Promise<void> => {
  if (before) await publishContactsUpdated(tx, [before]);
};
