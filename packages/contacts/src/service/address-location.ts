import { createHash } from "node:crypto";
import { type GeoAddress, GeoAddressSchema, type GeoGeocodeInput, GeoProvenanceSchema } from "@k2b/cloud/contracts/geo";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { SqlExecutor } from "./shared";
import type { ContactAddressInput, ContactAddressLocation } from "./types";

/**
 * Only a sure house-number match becomes a stored point. Geoapify reports this as
 * `rank.confidence_building_level`; 0.9 keeps street-level and interpolated guesses out.
 */
export const ADDRESS_BUILDING_CONFIDENCE = 0.9;

type AddressFields = Pick<ContactAddressInput, "line1" | "postalCode" | "city" | "stateRegion" | "countryCode">;
export type AddressGeoColumns = {
  geo_hash: string | null;
  geo_lat: number | null;
  geo_lon: number | null;
  geo_provenance: unknown;
  geo_checked_at: Date | null;
};

const normalize = (value: string | null | undefined) => (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Identifies the fields a location belongs to. Labels, recipients and the second line do not move a building. */
export const addressGeoHash = (address: AddressFields): string =>
  createHash("sha256")
    .update(JSON.stringify([address.line1, address.postalCode, address.city, address.stateRegion, address.countryCode].map(normalize)))
    .digest("hex");

/** A location only counts for the address text it was found for. */
export const addressLocation = (address: AddressFields, row: AddressGeoColumns): ContactAddressLocation | null => {
  if (!row.geo_hash || row.geo_hash !== addressGeoHash(address) || !row.geo_checked_at) return null;
  if (row.geo_lat === null || row.geo_lon === null) return { status: "not_found", checkedAt: row.geo_checked_at.toISOString() };
  const provenance = GeoProvenanceSchema.safeParse(
    typeof row.geo_provenance === "string" ? JSON.parse(row.geo_provenance) : row.geo_provenance,
  );
  return provenance.success
    ? { status: "found", point: { lat: row.geo_lat, lon: row.geo_lon }, provenance: provenance.data }
    : { status: "not_found", checkedAt: row.geo_checked_at.toISOString() };
};

/** Columns for a new address row: a chosen suggestion, else the unchanged previous location, else pending. */
/** An open lookup for the address text with this hash; it moves with the text when its row is replaced. */
export type AddressGeoClaim = { geo_lookup_at: Date | null; geo_lookup_hash: string | null };
type CarriedGeo = AddressGeoColumns & Partial<AddressGeoClaim>;

export const addressGeoColumns = (address: ContactAddressInput, previous: ReadonlyMap<string, CarriedGeo>): CarriedGeo | null => {
  const hash = addressGeoHash(address);
  if (address.location)
    return {
      geo_hash: hash,
      geo_lat: address.location.point.lat,
      geo_lon: address.location.point.lon,
      geo_provenance: address.location.provenance,
      geo_checked_at: new Date(address.location.provenance.computedAt),
    };
  return previous.get(hash) ?? null;
};

/** JSONB text for an insert; rows read back from Postgres may already carry it as text. */
export const geoProvenanceJson = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value);

/** Serialize address snapshots and lookup writes on a row that survives address replacement. Use inside a transaction. */
export const lockContactAddressGeo = async (contactId: string, db: SqlExecutor): Promise<void> => {
  await db`SELECT id FROM contacts.contacts WHERE id = ${contactId}::uuid FOR UPDATE`;
};

/** Stored answers and open lookups of a contact, keyed by the address hash they belong to. */
export const loadPreviousAddressGeo = async (contactId: string, db: SqlExecutor): Promise<Map<string, CarriedGeo>> => {
  const rows = await db<(AddressGeoColumns & AddressGeoClaim)[]>`
    SELECT geo_hash, geo_lat, geo_lon, geo_provenance, geo_checked_at, geo_lookup_at, geo_lookup_hash
    FROM contacts.contact_addresses
    WHERE contact_id = ${contactId}::uuid
      AND ((geo_hash IS NOT NULL AND geo_checked_at IS NOT NULL) OR geo_lookup_hash IS NOT NULL)
  `;
  const carried = new Map<string, CarriedGeo>();
  for (const row of rows) {
    if (row.geo_hash && row.geo_checked_at) carried.set(row.geo_hash, row);
    else if (row.geo_lookup_hash && !carried.has(row.geo_lookup_hash))
      carried.set(row.geo_lookup_hash, {
        geo_hash: null,
        geo_lat: null,
        geo_lon: null,
        geo_provenance: null,
        geo_checked_at: null,
        geo_lookup_at: row.geo_lookup_at,
        geo_lookup_hash: row.geo_lookup_hash,
      });
  }
  return carried;
};

/** The one sure candidate, or none: two different sure buildings are as unknown as none. */
export const safeAddressMatch = (candidates: readonly GeoAddress[]): GeoAddress | null => {
  const sure = candidates.filter((candidate) => (candidate.buildingConfidence ?? 0) >= ADDRESS_BUILDING_CONFIDENCE);
  return sure.length === 1 ? sure[0]! : null;
};

/** What Core answered, reduced to what Contacts stores or shows. */
export type AddressGeocodeOutcome =
  | { kind: "candidates"; candidates: GeoAddress[] }
  | { kind: "not_found" }
  | { kind: "not_configured" }
  | { kind: "budget_exhausted"; scope: "person" | "cloud"; resetsAt: string }
  | { kind: "failed" };

/** Reduces Core's `address.geocode` answer; ambiguity still yields a point when exactly one candidate is sure. */
export const geocodeOutcome = (
  result: { ok: true; data: { data: { address: GeoAddress } } } | { ok: false; error: { code: string; details?: Record<string, unknown> } },
): AddressGeocodeOutcome => {
  if (result.ok) return { kind: "candidates", candidates: [result.data.data.address] };
  const details = result.error.details ?? {};
  switch (result.error.code) {
    case "GEO_ADDRESS_AMBIGUOUS": {
      const candidates = GeoAddressSchema.array().max(5).safeParse(details.candidates);
      return candidates.success ? { kind: "candidates", candidates: candidates.data } : { kind: "failed" };
    }
    case "GEO_ADDRESS_NOT_FOUND":
      return { kind: "not_found" };
    case "GEO_NOT_CONFIGURED":
      return { kind: "not_configured" };
    case "GEO_BUDGET_EXHAUSTED":
      return (details.scope === "person" || details.scope === "cloud") && typeof details.resetsAt === "string"
        ? { kind: "budget_exhausted", scope: details.scope, resetsAt: details.resetsAt }
        : { kind: "failed" };
    default:
      return { kind: "failed" };
  }
};

export type ContactAddressLocateResult =
  | { state: "located"; location: ContactAddressLocation }
  | { state: "not_configured" }
  | { state: "budget_exhausted"; scope: "person" | "cloud"; resetsAt: string }
  | { state: "failed" };

type AddressRow = AddressGeoColumns &
  AddressGeoClaim & {
    line1: string;
    postal_code: string;
    city: string;
    state_region: string | null;
    country_code: string;
  };

const readAddress = async (contactId: string, addressId: string, db: SqlExecutor = sql) =>
  (
    await db<AddressRow[]>`
      SELECT line1, postal_code, city, state_region, country_code, geo_hash, geo_lat, geo_lon, geo_provenance, geo_checked_at,
        geo_lookup_at, geo_lookup_hash
      FROM contacts.contact_addresses
      WHERE id = ${addressId}::uuid AND contact_id = ${contactId}::uuid
    `
  )[0];
/** The row now holding this address text: the same row, or its replacement after an unchanged save. */
const readByHash = async (contactId: string, addressId: string, hash: string) =>
  (await readAddress(contactId, addressId)) ??
  (
    await sql<AddressRow[]>`
      SELECT line1, postal_code, city, state_region, country_code, geo_hash, geo_lat, geo_lon, geo_provenance, geo_checked_at,
        geo_lookup_at, geo_lookup_hash
      FROM contacts.contact_addresses
      WHERE contact_id = ${contactId}::uuid AND (geo_hash = ${hash} OR geo_lookup_hash = ${hash})
      ORDER BY position
      LIMIT 1
    `
  )[0];
const fields = (row: AddressRow): AddressFields => ({
  line1: row.line1,
  postalCode: row.postal_code,
  city: row.city,
  stateRegion: row.state_region,
  countryCode: row.country_code,
});

/**
 * Looks up a pending address once and stores the answer with its address hash. Callers authorize the
 * contact first and pass a geocoder that runs as the requesting person, on that person's budget.
 * A stored answer is returned without a new lookup; only a changed address searches again.
 */
/**
 * A claimed lookup outlives Core's geocode deadline (5 s) with margin; an older claim belongs to a lookup that died.
 * Waiting readers poll the row for that deadline plus slack, then report a retryable failure.
 */
const LOOKUP_CLAIM_SECONDS = 20;
const LOOKUP_WAIT_MS = 6000;
const LOOKUP_POLL_MS = 250;

export const locateAddress = async (config: {
  contactId: string;
  addressId: string;
  geocode: (input: GeoGeocodeInput) => Promise<AddressGeocodeOutcome>;
  now?: () => Date;
  /** The request's cancellation; a reader who left stops waiting. */
  signal?: AbortSignal;
}): Promise<Result<ContactAddressLocateResult>> => {
  // Read and claim under the same parent lock as replacement, before taking any address-row lock.
  const lookup = await sql.begin(async (tx) => {
    await lockContactAddressGeo(config.contactId, tx);
    const row = await readAddress(config.contactId, config.addressId, tx);
    if (!row) return null;
    if (addressLocation(fields(row), row)) return { row, claimed: false };
    const hash = addressGeoHash(fields(row));
    // The claim names the hash, so it survives a save that replaces an unchanged address.
    const claimed = await tx`
      UPDATE contacts.contact_addresses
      SET geo_lookup_at = statement_timestamp(), geo_lookup_hash = ${hash}
      WHERE id = ${config.addressId}::uuid
        AND contact_id = ${config.contactId}::uuid
        AND geo_hash IS DISTINCT FROM ${hash}
        AND (geo_lookup_at IS NULL OR geo_lookup_at < statement_timestamp() - make_interval(secs => ${LOOKUP_CLAIM_SECONDS}))
      RETURNING id
    `;
    return { row, claimed: claimed.length > 0 };
  });
  if (!lookup) return fail(err.notFound("Address"));
  const address = fields(lookup.row);
  const stored = addressLocation(address, lookup.row);
  if (stored) return ok({ state: "located", location: stored });
  const hash = addressGeoHash(address);

  // One paid lookup per address text: concurrent readers wait for the claimant's stored answer.
  if (!lookup.claimed) {
    const deadline = Date.now() + LOOKUP_WAIT_MS;
    while (Date.now() < deadline && !config.signal?.aborted) {
      const current = await readByHash(config.contactId, config.addressId, hash);
      if (!current) return fail(err.notFound("Address"));
      const location = addressLocation(fields(current), current);
      if (location) return ok({ state: "located", location });
      if (current.geo_lookup_hash !== hash) break;
      await Bun.sleep(LOOKUP_POLL_MS);
    }
    return ok({ state: "failed" });
  }

  let outcome: AddressGeocodeOutcome = { kind: "failed" };
  try {
    outcome = await config.geocode({
      fields: {
        line1: address.line1,
        postalCode: address.postalCode,
        city: address.city,
        ...(address.stateRegion ? { stateRegion: address.stateRegion } : {}),
      },
      countryCode: address.countryCode,
    });
  } finally {
    // Unstored answers release the claim at once, so the next reader may try again.
    if (outcome.kind !== "candidates" && outcome.kind !== "not_found")
      await sql.begin(async (tx) => {
        await lockContactAddressGeo(config.contactId, tx);
        await tx`
          UPDATE contacts.contact_addresses SET geo_lookup_at = NULL, geo_lookup_hash = NULL
          WHERE contact_id = ${config.contactId}::uuid AND geo_lookup_hash = ${hash}
        `;
      });
  }
  if (outcome.kind === "not_configured" || outcome.kind === "failed") return ok({ state: outcome.kind });
  if (outcome.kind === "budget_exhausted") return ok({ state: outcome.kind, scope: outcome.scope, resetsAt: outcome.resetsAt });

  const match = outcome.kind === "candidates" ? safeAddressMatch(outcome.candidates) : null;
  const checkedAt = match ? new Date(match.provenance.computedAt) : (config.now?.() ?? new Date());
  // The answer lands on whichever row still carries this address text; a changed address no longer carries the claim.
  await sql.begin(async (tx) => {
    await lockContactAddressGeo(config.contactId, tx);
    await tx`
      UPDATE contacts.contact_addresses
      SET geo_hash = ${hash},
          geo_lat = ${match?.point.lat ?? null},
          geo_lon = ${match?.point.lon ?? null},
          geo_provenance = (${geoProvenanceJson(match?.provenance)}::text)::jsonb,
          geo_checked_at = ${checkedAt},
          geo_lookup_at = NULL,
          geo_lookup_hash = NULL
      WHERE contact_id = ${config.contactId}::uuid
        AND geo_lookup_hash = ${hash}
        AND geo_hash IS DISTINCT FROM ${hash}
    `;
  });
  const current = await readByHash(config.contactId, config.addressId, hash);
  const location = current ? addressLocation(fields(current), current) : null;
  return location ? ok({ state: "located", location }) : fail(err.notFound("Address"));
};
