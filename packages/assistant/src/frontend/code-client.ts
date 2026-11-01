import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import type { CodeQueryInvoke } from "../code-summary";

/** The browser calls Core's public Code queries with the person's session, like any application page. */
export const browserCodeInvoke: CodeQueryInvoke = (invocation, schema) => invokeCapabilityWithDataSchema(invocation, schema);

/** Short local date and time, in the person's time zone, so the server and the browser print the same text. */
export const formatCodeTime = (iso: string, locale: string, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  }
};

/** A next run with its weekday, so a schedule reads at a glance; the same text on the server and in the browser. */
export const formatCodeNextRun = (iso: string, locale: string, timeZone: string): string => {
  const options = { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(new Date(iso));
  }
};
