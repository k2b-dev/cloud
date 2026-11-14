import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import type { AppEventEnvelope } from "@k2b/cloud/events";
import { appEventFixture } from "@k2b/cloud/events/testing";
import { accounts } from "@k2b/cloud/services";
import { ok, type Result } from "@k2b/stdlib";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import * as producer from "../app-events";
import { contactsCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { type BookCaller, contactsService } from ".";
import { MAX_BULK_CONTACTS } from "./contacts";
import * as imports from "./imports";

const suite = databaseSuite();
let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;
let owner: CapabilityExecutionContext;
let other: CapabilityExecutionContext;
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const caller = (context: CapabilityExecutionContext): BookCaller => ({ actor: context.actor, accessSubject: context.accessSubject });
beforeEach(() => setSystemTime(new Date("2026-11-07T12:00:00Z")));
afterEach(() => setSystemTime());
beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useMigratedDatabase("contacts_events");
  const contexts: CapabilityExecutionContext[] = [];
  for (const name of ["Owner", "Other"]) {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES (${`events-${name}-${crypto.randomUUID()}`}, 'local', 'user', ${name}) RETURNING id`;
    const user = await accounts.users.get({ id: row!.id });
    if (!user) throw new Error("Missing test user");
    contexts.push({
      user,
      actor: { kind: "user", user },
      accessSubject: { type: "user", userId: user.id },
      origin: "app",
      requestId: "contact-events",
      locale: "en",
      signal: new AbortController().signal,
    });
  }
  owner = contexts[0]!;
  other = contexts[1]!;
});
afterAll(async () => {
  await database?.drop();
});
const book = async () => {
  const [row] = await sql<
    { id: string; short_id: string }[]
  >`INSERT INTO contacts.books(short_id, name) VALUES (${newShortId()}, 'Private book') RETURNING id, short_id`;
  const [access] = await sql<
    { id: string }[]
  >`INSERT INTO auth.access(user_id, permission) VALUES (${owner.user!.id}::uuid, 'admin') RETURNING id`;
  await sql`INSERT INTO contacts.book_access(book_id, access_id) VALUES (${row!.id}::uuid, ${access!.id}::uuid)`;
  return row!;
};
const pending = async (shortId: string): Promise<AppEventEnvelope[]> =>
  (
    await sql<{ payload: AppEventEnvelope }[]>`
  SELECT payload FROM events.outbox WHERE app_id = 'contacts' AND kind = 'event' AND payload->'place'->>'id' = ${shortId} ORDER BY seq`
  ).map((row) => row.payload);
const create = async (bookId: string) =>
  unwrap(
    await contactsService.contact.create({
      ...caller(owner),
      bookId,
      data: { firstName: "Ada", emails: [{ label: "Work", email: "private@example.test" }] },
    }),
  );
const updated = async (shortId: string) => (await pending(shortId)).filter((event) => event.type === "contacts.contact.updated");

suite("Contacts transactional automation events", () => {
  test("creation uses public refs, readers check current grants, and idempotent retries stay quiet", async () => {
    const place = await book();
    const contact = await create(place.id);
    const [ref] = await sql<{ short_id: string }[]>`SELECT short_id FROM contacts.contacts WHERE id = ${contact.id}::uuid`;
    const events = await pending(place.short_id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "contacts.contact.created",
      subject: { type: "contacts.contact", id: ref!.short_id },
      place: { type: "contacts.book", id: place.short_id },
      data: {},
    });
    const reader = contactsCapabilities.queries["contact.read"];
    expect((await reader.run(reader.input.parse({ id: ref!.short_id }), owner)).ok).toBe(true);
    expect((await reader.run(reader.input.parse({ id: ref!.short_id }), other)).ok).toBe(false);
    const placeReader = contactsCapabilities.queries["book.read"];
    expect((await placeReader.run(placeReader.input.parse({ id: place.short_id }), other)).ok).toBe(false);
    const input = {
      ...caller(owner),
      bookId: place.id,
      data: { firstName: "Once" },
      actorKey: `user:${owner.user!.id}`,
      actionId: "events-create",
      idempotencyKeyHash: "retry",
      requestHash: "same",
    };
    expect(unwrap(await contactsService.contact.createIdempotent(input)).replayed).toBe(false);
    expect(unwrap(await contactsService.contact.createIdempotent(input)).replayed).toBe(true);
    expect(await pending(place.short_id)).toHaveLength(2);
  });

  test("updates compare normalized stored values, including rebuilt collections, and name only changed groups", async () => {
    const place = await book();
    const contact = await create(place.id);
    const config = { ...caller(owner), bookId: place.id, id: contact.id };
    expect(
      (
        await contactsService.contact.update({
          ...config,
          data: { firstName: " Ada ", emails: [{ label: "Work", email: "private@example.test" }] },
        })
      ).ok,
    ).toBe(true);
    expect(await updated(place.short_id)).toHaveLength(0);
    const changes = {
      firstName: "Grace",
      emails: [{ email: "other@example.test" }],
      phones: [{ phone: "+491234567" }],
      addresses: [{ line1: "Private street", postalCode: "10115", city: "Private city", countryCode: "DE" }],
      websites: [{ url: "https://example.test" }],
      bankAccounts: [{ accountHolderName: "Private holder", iban: "DE89370400440532013000" }],
    };
    expect((await contactsService.contact.update({ ...config, data: changes })).ok).toBe(true);
    expect((await updated(place.short_id)).map((event) => event.data)).toEqual([
      { changed: ["profile", "emails", "phones", "addresses", "websites", "bankAccounts"] },
    ]);
    await Promise.all([
      contactsService.contact.update({ ...config, data: { ...changes, firstName: "Concurrent" } }),
      contactsService.contact.update({ ...config, data: { ...changes, firstName: "Concurrent" } }),
    ]);
    expect((await updated(place.short_id)).map((event) => event.data)).toEqual([
      { changed: ["profile", "emails", "phones", "addresses", "websites", "bankAccounts"] },
      { changed: ["profile"] },
    ]);
    for (const event of await pending(place.short_id)) {
      expect(Object.keys(event).sort()).toEqual(["data", "id", "place", "source", "subject", "time", "type", "version"]);
      expect(JSON.stringify(event)).not.toContain("Private");
      expect(JSON.stringify(event)).not.toContain("example.test");
    }
  });

  test("tag assignment and note changes publish once per real change, including idempotent note creation", async () => {
    const place = await book();
    const contact = await create(place.id);
    const tag = unwrap(
      await contactsService.tag.create({ ...caller(owner), bookId: place.id, data: { name: "Private tag", color: "#123456" } }),
    );
    const config = { ...caller(owner), bookId: place.id, contactId: contact.id };
    for (let n = 0; n < 2; n++)
      expect((await contactsService.tag.changeAssignments({ ...config, addTagIds: [tag.id], removeTagIds: [] })).ok).toBe(true);
    const noteInput = {
      ...config,
      data: { content: "Private note" },
      actorKey: `user:${owner.user!.id}`,
      actionId: "events-note",
      idempotencyKeyHash: "retry",
      requestHash: "same",
    };
    const created = unwrap(await contactsService.contact.notes.createIdempotent(noteInput));
    expect(unwrap(await contactsService.contact.notes.createIdempotent(noteInput)).replayed).toBe(true);
    // Freeze at the row's birth: the author window does not depend on the day CI runs.
    setSystemTime(new Date(created.note.createdAt));
    expect((await contactsService.contact.notes.update({ ...config, noteId: created.note.id, data: { content: "Private note" } })).ok).toBe(
      true,
    );
    expect((await updated(place.short_id)).map((event) => event.data)).toEqual([{ changed: ["tags"] }, { changed: ["notes"] }]);
  });

  test("failed creation or update publication rolls back the whole domain transaction", async () => {
    const place = await book();
    const contact = await create(place.id);
    const before = await pending(place.short_id);
    const original = producer.publishContactsEvent;
    const failure = spyOn(producer, "publishContactsEvent").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("event rollback");
    });
    try {
      await expect(create(place.id)).rejects.toThrow("event rollback");
      await expect(
        contactsService.contact.update({ ...caller(owner), bookId: place.id, id: contact.id, data: { firstName: "Rollback" } }),
      ).rejects.toThrow("event rollback");
    } finally {
      failure.mockRestore();
    }
    expect(await sql`SELECT id FROM contacts.contacts WHERE book_id = ${place.id}::uuid`).toHaveLength(1);
    expect(unwrap(await contactsService.contact.get({ ...caller(owner), bookId: place.id, id: contact.id }))?.firstName).toBe("Ada");
    expect(await pending(place.short_id)).toEqual(before);
  });

  test("bounded imports keep one event for each committed contact, including partial failure", async () => {
    const place = await book();
    const candidates = Array.from({ length: imports.MAX_IMPORT_CONTACTS }, (_, index) => index);
    const result = unwrap(
      await contactsService.import.commit({
        ...caller(owner),
        bookId: place.id,
        candidates,
        validateCandidate: (value) => ok({ firstName: `Import ${value}` }),
      }),
    );
    expect(result).toEqual({ created: imports.MAX_IMPORT_CONTACTS, failures: [] });
    const events = await pending(place.short_id);
    expect(events).toHaveLength(imports.MAX_IMPORT_CONTACTS);
    expect(new Set(events.map((event) => event.subject.id)).size).toBe(imports.MAX_IMPORT_CONTACTS);
    expect(events.every((event) => event.type === "contacts.contact.created" && JSON.stringify(event.data) === "{}")).toBe(true);
    expect(events.length * (4096 + 1024)).toBeLessThanOrEqual(0.02 * 256 * 1024 ** 2);
    const tag = unwrap(
      await contactsService.tag.create({ ...caller(owner), bookId: place.id, data: { name: "Imported", color: "#123456" } }),
    );
    const imported = await sql<
      { id: string }[]
    >`SELECT id FROM contacts.contacts WHERE book_id = ${place.id}::uuid ORDER BY id LIMIT ${MAX_BULK_CONTACTS}`;
    expect(
      unwrap(
        await contactsService.contact.bulk.addTags({
          ...caller(owner),
          bookId: place.id,
          ids: imported.map((contact) => contact.id),
          tagIds: [tag.id],
        }),
      ),
    ).toBe(MAX_BULK_CONTACTS);
    expect(await updated(place.short_id)).toHaveLength(MAX_BULK_CONTACTS);
    const creations = async () => (await pending(place.short_id)).filter((event) => event.type === "contacts.contact.created");
    const refused = unwrap(
      await contactsService.import.commit({
        ...caller(owner),
        bookId: place.id,
        candidates: [...candidates, 1001],
        validateCandidate: () => {
          throw new Error("must not validate oversized import");
        },
      }),
    );
    expect(refused.created).toBe(0);
    expect(refused.failures).toHaveLength(1);
    expect(await creations()).toHaveLength(imports.MAX_IMPORT_CONTACTS);
    await expect(
      contactsService.import.commit({
        ...caller(owner),
        bookId: place.id,
        candidates: ["committed", "stop"],
        validateCandidate: (value) => {
          if (value === "stop") throw new Error("stopped");
          return ok({ firstName: "Committed" });
        },
      }),
    ).rejects.toThrow("stopped");
    expect(await creations()).toHaveLength(imports.MAX_IMPORT_CONTACTS + 1);
  }, 120_000);

  test("bulk tags emit only changed contacts and moves announce only the destination place", async () => {
    const place = await book();
    const target = await book();
    const contacts = await Promise.all([create(place.id), create(place.id), create(place.id)]);
    const tag = unwrap(await contactsService.tag.create({ ...caller(owner), bookId: place.id, data: { name: "Bulk", color: "#123456" } }));
    for (let n = 0; n < 2; n++)
      expect(
        (
          await contactsService.contact.bulk.addTags({
            ...caller(owner),
            bookId: place.id,
            ids: contacts.map((item) => item.id),
            tagIds: [tag.id],
          })
        ).ok,
      ).toBe(true);
    expect((await updated(place.short_id)).map((event) => event.data)).toEqual(Array(3).fill({ changed: ["tags"] }));
    const refused = await contactsService.contact.bulk.addTags({
      ...caller(owner),
      bookId: place.id,
      ids: Array.from({ length: MAX_BULK_CONTACTS + 1 }, () => crypto.randomUUID()),
      tagIds: [tag.id],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toBe(`Choose at most ${MAX_BULK_CONTACTS} contacts`);
    const before = await pending(place.short_id);
    expect(
      (
        await contactsService.contact.bulk.move({
          ...caller(owner),
          sourceBookId: place.id,
          targetBookId: target.id,
          ids: contacts.map((item) => item.id),
        })
      ).ok,
    ).toBe(true);
    expect(await pending(place.short_id)).toEqual(before);
    expect((await updated(target.short_id)).map((event) => event.data)).toEqual(Array(3).fill({ changed: ["tags", "book"] }));
  });

  test("fixtures stay inside the shared size budget at the full changed-group bound", async () => {
    for (const name of ["contact.created", "contact.updated"] as const) {
      const event = appEventFixture(
        contactsCapabilities,
        name,
        { subject: "Cnt001", place: "Bok001", data: name === "contact.updated" ? { changed: [...producer.CONTACT_FIELD_GROUPS] } : {} },
        { appId: "contacts" },
      );
      const [row] = await sql<{ bytes: number }[]>`SELECT octet_length(${JSON.stringify(event)}::text::jsonb::text) AS bytes`;
      expect(row!.bytes).toBe(name === "contact.created" ? 275 : 393);
    }
  });
});
