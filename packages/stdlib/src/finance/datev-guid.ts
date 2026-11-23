import { z } from "zod";

// DATEV Document_types_v060.xsd, p10037: 36 characters, hexadecimal in either case,
// 8-4-4-4-12 with hyphens, no braces; preserve the caller's spelling.
// https://developer.datev.de/assets/XSD_3c866dbe96.zip
// Reuse this document GUID in EXTF column 20 (Beleglink).
export const datevGuid = z.string().length(36).regex(
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/,
  "Expected a GUID like 9FFD1116-DA0C-4A30-95D4-EF93FE31097A (no braces).",
);
