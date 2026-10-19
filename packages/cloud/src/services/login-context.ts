import {
  APP_APPROVAL_LIMITS,
  type AppDeviceInbox,
  type AppDeviceInboxWithChanges,
  type AppLoginContext,
  AppLoginContextSchema,
  type AppPendingLogin,
} from "../contracts/app-approval";
import { truncateUtf8 } from "../server/request-context/geoip";
import { KNOWN_BROWSER_LIMITS } from "./known-browsers";

export type AppLoginRequestContext = Pick<AppLoginContext, "browser" | "os" | "country" | "city" | "network"> & {
  cookie: string | null;
  prefix: string | null;
};
export type LoginContextInput = {
  request?: AppLoginRequestContext;
  browser: { firstSeenAt: Date } | null;
  countries: { seen: boolean; any: boolean };
  trust: { introActive: boolean; geoipSince: Date | null };
  now: Date;
};

/** Core's only level rule. Descriptions and same-network hints do not affect it. */
export const loginContextLevel = (input: {
  introActive: boolean;
  knownBrowser: boolean;
  newCountry: boolean;
  anyCountry: boolean;
}): AppLoginContext["level"] => {
  if (input.introActive) return "info";
  if (input.knownBrowser) return input.newCountry ? "hint" : "info";
  return input.newCountry && input.anyCountry ? "warn" : "hint";
};

/** JSONB adds a space after each colon and comma. Two bytes per entry bound
 * both separators, including nested objects/arrays, without counting punctuation in strings. */
export const loginContextStorageBytes = (value: unknown): number => {
  const separators = (item: unknown): number => {
    if (!item || typeof item !== "object") return 0;
    const values = Object.values(item);
    return 2 * values.length + values.reduce<number>((sum, entry) => sum + separators(entry), 0);
  };
  return new TextEncoder().encode(JSON.stringify(value)).length + separators(value);
};

/** Never store sameNetwork. Oversized or invalid context cannot prevent a sign-in. */
export const boundLoginContext = (input: AppLoginContext): AppLoginContext | null => {
  const { sameNetwork: _transient, ...context } = input;
  if (loginContextStorageBytes(context) > 512) {
    context.city = null;
    context.network = null;
  }
  if (loginContextStorageBytes(context) > 512) return null;
  const parsed = AppLoginContextSchema.safeParse(context);
  return parsed.success ? parsed.data : null;
};

export const buildLoginContext = ({ request, browser, countries, trust, now }: LoginContextInput): AppLoginContext | null => {
  const country = request?.country ?? null;
  const newCountry = country !== null && trust.geoipSince !== null && !countries.seen;
  const name = (value: string | null | undefined) =>
    value
      ? truncateUtf8(
          value
            .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
            .replace(/\p{Cf}/gu, "")
            .replace(/\s+/gu, " ")
            .trim(),
          96,
        ) || null
      : null;
  return boundLoginContext({
    level: loginContextLevel({ introActive: trust.introActive, knownBrowser: browser !== null, newCountry, anyCountry: countries.any }),
    browser: request?.browser ?? "other",
    os: request?.os ?? "other",
    country,
    city: name(request?.city),
    network: name(request?.network),
    history: trust.introActive
      ? null
      : {
          knownSince: browser?.firstSeenAt.toISOString() ?? null,
          newCountry,
          countriesSince:
            trust.geoipSince && now.getTime() - trust.geoipSince.getTime() < KNOWN_BROWSER_LIMITS.retentionDays * 86_400_000
              ? trust.geoipSince.toISOString()
              : null,
        },
  });
};

type LoginListResponse = AppDeviceInbox | AppDeviceInboxWithChanges | { requests: AppPendingLogin[]; pollAfterSeconds: number };
/** Keep every login: trim Actions first, then device changes, then context from the last login backwards.
 * Trimmed changes stay pending and show once the inbox has room.
 * Return a copy so callers and tests can retain the original snapshot. */
export const trimAppLoginResponse = <T extends LoginListResponse>(response: T, budget: number = APP_APPROVAL_LIMITS.bodyBytes): T => {
  const result = { ...response };
  const bytes = () => new TextEncoder().encode(JSON.stringify(result)).length;
  if ("logins" in result) {
    result.actions = [...result.actions];
    result.logins = result.logins.map((login) => ({ ...login }));
    while (result.actions.length && bytes() > budget) {
      result.actions.pop();
      result.moreActions++;
    }
    if ("changes" in result) {
      result.changes = [...result.changes];
      while (result.changes.length && bytes() > budget) {
        result.changes.pop();
        result.moreChanges++;
      }
    }
  } else result.requests = result.requests.map((login) => ({ ...login }));
  const logins = "logins" in result ? result.logins : result.requests;
  for (let index = logins.length - 1; index >= 0 && bytes() > budget; index--) delete logins[index]!.context;
  return result;
};
