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
export const addressGeoColumns = (
  address: ContactAddressInput,
  previous: ReadonlyMap<string, AddressGeoColumns>,
): AddressGeoColumns | null => {
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

export const loadPreviousAddressGeo = async (contactId: string, db: SqlExecutor): Promise<Map<string, AddressGeoColumns>> => {
  const rows = await db<AddressGeoColumns[]>`
    SELECT geo_hash, geo_lat, geo_lon, geo_provenance, geo_checked_at
    FROM contacts.contact_addresses
    WHERE contact_id = ${contactId}::uuid AND geo_hash IS NOT NULL AND geo_checked_at IS NOT NULL
  `;
  return new Map(rows.map((row) => [row.geo_hash!, row]));
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

type AddressRow = AddressGeoColumns & {
  line1: string;
  postal_code: string;
  city: string;
  state_region: string | null;
  country_code: string;
};

const readAddress = async (contactId: string, addressId: string) =>
  (
    await sql<AddressRow[]>`
      SELECT line1, postal_code, city, state_region, country_code, geo_hash, geo_lat, geo_lon, geo_provenance, geo_checked_at
      FROM contacts.contact_addresses
      WHERE id = ${addressId}::uuid AND contact_id = ${contactId}::uuid
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
export const locateAddress = async (config: {
  contactId: string;
  addressId: string;
  geocode: (input: GeoGeocodeInput) => Promise<AddressGeocodeOutcome>;
  now?: () => Date;
}): Promise<Result<ContactAddressLocateResult>> => {
  const row = await readAddress(config.contactId, config.addressId);
  if (!row) return fail(err.notFound("Address"));
  const address = fields(row);
  const stored = addressLocation(address, row);
  if (stored) return ok({ state: "located", location: stored });

  const outcome = await config.geocode({
    fields: {
      line1: address.line1,
      postalCode: address.postalCode,
      city: address.city,
      ...(address.stateRegion ? { stateRegion: address.stateRegion } : {}),
    },
    countryCode: address.countryCode,
  });
  if (outcome.kind === "not_configured" || outcome.kind === "failed") return ok({ state: outcome.kind });
  if (outcome.kind === "budget_exhausted") return ok({ state: outcome.kind, scope: outcome.scope, resetsAt: outcome.resetsAt });

  const match = outcome.kind === "candidates" ? safeAddressMatch(outcome.candidates) : null;
  const hash = addressGeoHash(address);
  const checkedAt = match ? new Date(match.provenance.computedAt) : (config.now?.() ?? new Date());
  // An edit replaces the row, so a lookup for the old text never lands on the new one.
  await sql`
    UPDATE contacts.contact_addresses
    SET geo_hash = ${hash},
        geo_lat = ${match?.point.lat ?? null},
        geo_lon = ${match?.point.lon ?? null},
        geo_provenance = (${geoProvenanceJson(match?.provenance)}::text)::jsonb,
        geo_checked_at = ${checkedAt}
    WHERE id = ${config.addressId}::uuid
      AND contact_id = ${config.contactId}::uuid
      AND geo_hash IS DISTINCT FROM ${hash}
  `;
  const current = await readAddress(config.contactId, config.addressId);
  const location = current ? addressLocation(fields(current), current) : null;
  return location ? ok({ state: "located", location }) : fail(err.notFound("Address"));
};
