import { z } from "zod";

/** Canonical HTTPS scheme, host and effective port. No wildcard, credentials, path or final DNS dot. */
export const CodeInternetOriginSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.origin === value &&
        !url.username &&
        !url.password &&
        !url.hostname.endsWith(".") &&
        !url.hostname.includes("*")
      );
    } catch {
      return false;
    }
  }, "Use an exact HTTPS origin without wildcard, credentials, path or final DNS dot.");
/** Immutable version destinations, including requests without secrets. Absent/empty means no internet access. */
export const CodeInternetOriginsSchema = z
  .array(CodeInternetOriginSchema)
  .refine((origins) => new Set(origins).size === origins.length, "Internet origins must be unique");
