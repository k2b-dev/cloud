export type GeoIpKind = "city" | "asn";
export const GEOIP_MAX_DATABASE_BYTES = 192 * 1024 * 1024;
export const GEOIP_MAX_REQUEST_BYTES = 128 * 1024 * 1024;
export const DBIP_ATTRIBUTION = {
  text: "IP Geolocation by DB-IP",
  url: "https://db-ip.com",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
} as const;

export type GeoIpAdminDatabase = {
  kind: GeoIpKind;
  source: "uploaded" | "bundled" | null;
  /** A bundled snapshot exists for this type, so a reset returns to it. */
  bundled: boolean;
  databaseType: string | null;
  buildDate: string | null;
  stale: boolean;
  dbIp: boolean;
  upload: {
    sha256: string;
    size: number;
    uploadedAt: string;
    uploadedBy: { id: string; name: string } | null;
  } | null;
};
export type GeoIpAdminStatus = {
  databases: [GeoIpAdminDatabase, GeoIpAdminDatabase];
  attribution: typeof DBIP_ATTRIBUTION | null;
  limits: { maxDatabaseBytes: number; maxRequestBytes: number };
};

export type GeoIpUploadResult = GeoIpAdminStatus & { kind: GeoIpKind };
export type GeoIpResetResult = GeoIpAdminStatus & { changed: boolean };

export type GeoIpErrorCode = "geoip_too_large" | "geoip_empty" | "geoip_invalid" | "geoip_unsupported_type" | "geoip_upload_busy";
