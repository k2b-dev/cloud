import type { CloudResourceRef } from "./capabilities";

/**
 * The permanent Cloud path of a resource. The fixed `~` keeps the ids `.` and `..` from being read as dot segments.
 * This module stays free of runtime imports: the `cld` host loads it at startup.
 */
export const cloudResourceHref = (ref: CloudResourceRef): string => `/open/${ref.type}/~${encodeURIComponent(ref.id)}`;
