import { DBIP_ATTRIBUTION, type GeoIpAdminDatabase, type GeoIpAdminStatus } from "@k2b/cloud/contracts";

// Fixed dates: nothing here depends on the day a test runs.
const limits = { maxDatabaseBytes: 192 * 1024 * 1024, maxRequestBytes: 128 * 1024 * 1024 };

const bundled = (kind: GeoIpAdminDatabase["kind"], buildDate = "2026-10-01T00:00:00.000Z", stale = false): GeoIpAdminDatabase => ({
  kind,
  source: "bundled",
  bundled: true,
  databaseType: kind === "city" ? "DBIP-City-Lite" : "DBIP-ASN-Lite (compat=GeoLite2-ASN)",
  buildDate,
  stale,
  dbIp: true,
  upload: null,
});

export const bundledStatus: GeoIpAdminStatus = { databases: [bundled("city"), bundled("asn")], attribution: DBIP_ATTRIBUTION, limits };

export const uploadedStatus: GeoIpAdminStatus = {
  databases: [
    {
      kind: "city",
      source: "uploaded",
      bundled: true,
      databaseType: "GeoLite2-City",
      buildDate: "2026-10-14T00:00:00.000Z",
      stale: false,
      dbIp: false,
      upload: {
        sha256: "ab".repeat(32),
        size: 62_000_000,
        uploadedAt: "2026-10-16T09:30:00.000Z",
        uploadedBy: { id: "11111111-1111-4111-8111-111111111111", name: "Jana Novak" },
      },
    },
    bundled("asn"),
  ],
  attribution: DBIP_ATTRIBUTION,
  limits,
};

export const maxmindStatus: GeoIpAdminStatus = {
  databases: [
    uploadedStatus.databases[0],
    {
      ...uploadedStatus.databases[0],
      kind: "asn",
      databaseType: "GeoLite2-ASN",
      upload: { ...uploadedStatus.databases[0].upload!, uploadedBy: null },
    },
  ],
  attribution: null,
  limits,
};

export const staleStatus: GeoIpAdminStatus = {
  databases: [bundled("city", "2026-03-01T00:00:00.000Z", true), bundled("asn", "2026-03-01T00:00:00.000Z", true)],
  attribution: DBIP_ATTRIBUTION,
  limits,
};

const empty = (kind: GeoIpAdminDatabase["kind"]): GeoIpAdminDatabase => ({
  kind,
  source: null,
  bundled: false,
  databaseType: null,
  buildDate: null,
  stale: false,
  dbIp: false,
  upload: null,
});

/** Development without the bundled snapshot. */
export const emptyStatus: GeoIpAdminStatus = { databases: [empty("city"), empty("asn")], attribution: null, limits };
