import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { GeoAddress, GeoGeocodeInput } from "@k2b/cloud/contracts/geo";
import { accounts } from "@k2b/cloud/services";
import type { Result } from "@k2b/stdlib";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { type BookCaller, contactsService } from ".";
import type { AddressGeocodeOutcome } from "./address-location";
import type { Contact } from "./types";

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);
const marker = `address-location-${crypto.randomUUID()}`;
const userIds: string[] = [];
const bookIds: string[] = [];
const accessIds: string[] = [];
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const provenance = {
  provider: "geoapify" as const,
  attribution: { text: "Geoapify · OpenStreetMap" as const, links: ["https://geoapify.com", "https://www.openstreetmap.org/copyright"] },
  computedAt: "2026-10-22T10:00:00.000Z",
};
const sure = (lat: number, buildingConfidence = 1): GeoAddress => ({
  line1: "Frauenstraße 28",
  postalCode: "89073",
  city: "Ulm",
  stateRegion: "Baden-Württemberg",
  countryCode: "DE",
  point: { lat, lon: 9.99 },
  formatted: "Frauenstraße 28, 89073 Ulm, Germany",
  confidence: 1,
  buildingConfidence,
  provenance,
});
const address = { line1: "Frauenstraße 28", postalCode: "89073", city: "Ulm", countryCode: "DE", label: "Business" };

const person = async (name: string): Promise<BookCaller> => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, admin)
    VALUES (${id}::uuid, ${`${marker}-${name}`}, 'local', 'user', ${name}, false)`;
  userIds.push(id);
  const user = await accounts.users.get({ id });
  if (!user) throw new Error("Missing fixture user");
  return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: id } };
};
const grant = async (bookId: string, caller: BookCaller, permission: "read" | "write") => {
  if (caller.accessSubject.type !== "user") throw new Error("Expected user");
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission)
    VALUES (${caller.accessSubject.userId}::uuid, ${permission}::auth.permission_level) RETURNING id`;
  accessIds.push(row!.id);
  await sql`INSERT INTO contacts.book_access (book_id, access_id) VALUES (${bookId}::uuid, ${row!.id}::uuid)`;
};

suite("Contacts address location", () => {
  let reader: BookCaller;
  let writer: BookCaller;
  let stranger: BookCaller;
  let bookId: string;

  beforeAll(async () => {
    reader = await person("reader");
    writer = await person("writer");
    stranger = await person("stranger");
    bookId = crypto.randomUUID();
    await sql`INSERT INTO contacts.books (id, short_id, name) VALUES (${bookId}::uuid, ${newShortId()}, ${marker})`;
    bookIds.push(bookId);
    await grant(bookId, reader, "read");
    await grant(bookId, writer, "write");
  });

  afterAll(async () => {
    if (bookIds.length) {
      await sql`DELETE FROM events.outbox WHERE app_id = 'contacts' AND ordering_key IN ${sql(bookIds)}`;
      await sql`DELETE FROM contacts.books WHERE id IN ${sql(bookIds)}`;
    }
    if (accessIds.length) await sql`DELETE FROM auth.access WHERE id IN ${sql(accessIds)}`;
    if (userIds.length) await sql`DELETE FROM auth.users WHERE id IN ${sql(userIds)}`;
  });

  const create = async (
    input: Partial<typeof address> & { location?: { point: GeoAddress["point"]; provenance: typeof provenance } } = {},
  ) =>
    unwrap(await contactsService.contact.create({ ...writer, bookId, data: { firstName: marker, addresses: [{ ...address, ...input }] } }));
  const get = async (id: string) => unwrap(await contactsService.contact.get({ ...reader, bookId, id })) as Contact;
  const geocoder = (outcome: AddressGeocodeOutcome) => {
    const calls: GeoGeocodeInput[] = [];
    return {
      calls,
      geocode: async (input: GeoGeocodeInput) => {
        calls.push(input);
        return outcome;
      },
    };
  };
  const locate = (caller: BookCaller, contact: Contact, geocode: (input: GeoGeocodeInput) => Promise<AddressGeocodeOutcome>) =>
    contactsService.contact.locateAddress({ ...caller, bookId, contactId: contact.id, addressId: contact.addresses[0]!.id, geocode });

  test("saving without a suggestion leaves the location pending; a reader resolves it once on their budget", async () => {
    const contact = await create();
    expect(contact.addresses[0]!.location).toBeNull();

    const denied = geocoder({ kind: "candidates", candidates: [sure(48.4)] });
    expect(await locate(stranger, contact, denied.geocode)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(denied.calls).toHaveLength(0);

    const found = geocoder({ kind: "candidates", candidates: [sure(48.4)] });
    expect(unwrap(await locate(reader, contact, found.geocode))).toEqual({
      state: "located",
      location: { status: "found", point: { lat: 48.4, lon: 9.99 }, provenance },
    });
    expect(found.calls).toEqual([{ fields: { line1: "Frauenstraße 28", postalCode: "89073", city: "Ulm" }, countryCode: "DE" }]);

    const again = geocoder({ kind: "failed" });
    expect(unwrap(await locate(reader, contact, again.geocode))).toMatchObject({ state: "located", location: { status: "found" } });
    expect(again.calls).toHaveLength(0);
    expect((await get(contact.id)).addresses[0]!.location).toMatchObject({ status: "found", point: { lat: 48.4 } });
  });

  test("an unsure or missing match is stored as not found and only a changed address searches again", async () => {
    const contact = await create({ line1: "Frauenstraße 30" });
    const unsure = geocoder({ kind: "candidates", candidates: [sure(48.4, 0.6)] });
    expect(unwrap(await locate(reader, contact, unsure.geocode))).toMatchObject({ state: "located", location: { status: "not_found" } });
    const repeat = geocoder({ kind: "candidates", candidates: [sure(48.4)] });
    expect(unwrap(await locate(reader, contact, repeat.geocode))).toMatchObject({ location: { status: "not_found" } });
    expect(repeat.calls).toHaveLength(0);

    const changed = unwrap(
      await contactsService.contact.update({
        ...writer,
        bookId,
        id: contact.id,
        data: { addresses: [{ ...address, line1: "Frauenstraße 32" }] },
      }),
    );
    expect(changed.addresses[0]!.location).toBeNull();
    const fresh = geocoder({ kind: "not_found" });
    expect(unwrap(await locate(reader, changed, fresh.geocode))).toMatchObject({ location: { status: "not_found" } });
    expect(fresh.calls).toHaveLength(1);
  });

  test("a chosen suggestion is stored with its provenance; unchanged saves keep it and an edit drops it", async () => {
    const contact = await create({ location: { point: { lat: 48.39, lon: 9.98 }, provenance } });
    expect(contact.addresses[0]!.location).toEqual({ status: "found", point: { lat: 48.39, lon: 9.98 }, provenance });

    // Labels, recipients and case changes do not move the building.
    const relabeled = unwrap(
      await contactsService.contact.update({
        ...writer,
        bookId,
        id: contact.id,
        data: { addresses: [{ ...address, line1: "frauenstraße  28", label: "Office", recipientName: "Jana" }] },
      }),
    );
    expect(relabeled.addresses[0]!.location).toMatchObject({ status: "found", point: { lat: 48.39 } });

    const edited = unwrap(
      await contactsService.contact.update({
        ...writer,
        bookId,
        id: contact.id,
        data: { addresses: [{ ...address, postalCode: "89079" }] },
      }),
    );
    expect(edited.addresses[0]!.location).toBeNull();
  });

  test("budget and configuration answers store nothing, and a stale address id finds nothing", async () => {
    const contact = await create({ line1: "Frauenstraße 40" });
    for (const outcome of [
      { kind: "budget_exhausted", scope: "person", resetsAt: "2026-10-22T22:00:00.000Z" },
      { kind: "not_configured" },
      { kind: "failed" },
    ] as const) {
      const result = unwrap(await locate(reader, contact, geocoder(outcome).geocode));
      expect(result.state).toBe(outcome.kind);
    }
    expect((await get(contact.id)).addresses[0]!.location).toBeNull();

    // An edit while a lookup runs replaces the row; the old answer never lands on the new address.
    const slow = await create({ line1: "Frauenstraße 42" });
    const result = await locate(reader, slow, async () => {
      await contactsService.contact.update({
        ...writer,
        bookId,
        id: slow.id,
        data: { addresses: [{ ...address, line1: "Frauenstraße 44" }] },
      });
      return { kind: "candidates", candidates: [sure(48.4)] };
    });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect((await get(slow.id)).addresses[0]!.location).toBeNull();
  });
  test("concurrent readers share one paid lookup; a failed claimant lets the next reader try", async () => {
    const contact = await create({ line1: "Frauenstraße 50" });
    let calls = 0;
    const slow = async (): Promise<AddressGeocodeOutcome> => {
      calls += 1;
      await Bun.sleep(300);
      return { kind: "candidates", candidates: [sure(48.45)] };
    };
    const results = await Promise.all([locate(reader, contact, slow), locate(writer, contact, slow), locate(reader, contact, slow)]);
    expect(calls).toBe(1);
    for (const result of results)
      expect(unwrap(result)).toMatchObject({ state: "located", location: { status: "found", point: { lat: 48.45 } } });

    const failing = await create({ line1: "Frauenstraße 52" });
    expect(unwrap(await locate(reader, failing, geocoder({ kind: "failed" }).geocode))).toEqual({ state: "failed" });
    const retry = geocoder({ kind: "candidates", candidates: [sure(48.46)] });
    expect(unwrap(await locate(reader, failing, retry.geocode))).toMatchObject({ state: "located", location: { status: "found" } });
    expect(retry.calls).toHaveLength(1);
  });
  test("a save that keeps the address text keeps the open lookup, so readers still share one paid call", async () => {
    const contact = await create({ line1: "Frauenstraße 54" });
    let calls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = async (): Promise<AddressGeocodeOutcome> => {
      calls += 1;
      await held;
      return { kind: "candidates", candidates: [sure(48.47)] };
    };
    const first = locate(reader, contact, slow);
    await Bun.sleep(100);
    // A label-only save replaces the row while the lookup runs.
    const relabeled = unwrap(
      await contactsService.contact.update({
        ...writer,
        bookId,
        id: contact.id,
        data: { addresses: [{ ...address, line1: "Frauenstraße 54", label: "Büro" }] },
      }),
    );
    expect(relabeled.addresses[0]!.id).not.toBe(contact.addresses[0]!.id);
    const second = locate(reader, relabeled, slow);
    await Bun.sleep(100);
    release();
    expect(unwrap(await first)).toMatchObject({ state: "located", location: { status: "found", point: { lat: 48.47 } } });
    expect(unwrap(await second)).toMatchObject({ state: "located", location: { status: "found", point: { lat: 48.47 } } });
    expect(calls).toBe(1);
    expect((await get(contact.id)).addresses[0]!.location).toMatchObject({ status: "found", point: { lat: 48.47 } });
  });
});
