import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { MAX_GQL_RESULT_CURSOR_LENGTH } from "../contracts";

export type DslResultCursor = {
  fingerprint: string;
  pageSize: number;
  start: number;
  values: unknown[] | null;
};

type SerializedDslResultCursor = {
  f: string;
  n: number;
  s: number;
  v: 1;
  x: unknown[] | null;
};

const CURSOR_SIGNATURE_DOMAIN = "grids:gql-result-cursor:v1\0";

const signatureFor = (payload: string, signingKey: string): string =>
  createHmac("sha256", signingKey).update(CURSOR_SIGNATURE_DOMAIN).update(payload).digest("base64url");

const jsonValue = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  return value;
};

export const gqlResultFingerprint = (input: { baseId: string; canonicalSource: string; scope?: string }): string =>
  createHash("sha256")
    .update(input.baseId)
    .update("\0")
    .update(input.scope ?? "")
    .update("\0")
    .update(input.canonicalSource)
    .digest("base64url")
    .slice(0, 32);

export const encodeDslResultCursor = (cursor: DslResultCursor, signingKey: string): string => {
  if (!signingKey) throw new Error("GQL cursor signing key is required");
  const serialize = (values: unknown[] | null): string => {
    const serialized: SerializedDslResultCursor = {
      v: 1,
      f: cursor.fingerprint,
      s: cursor.start,
      n: cursor.pageSize,
      x: values,
    };
    const payload = Buffer.from(JSON.stringify(serialized), "utf8").toString("base64url");
    return `${payload}.${signatureFor(payload, signingKey)}`;
  };
  const token = serialize(cursor.values?.map(jsonValue) ?? null);
  if (token.length <= MAX_GQL_RESULT_CURSOR_LENGTH) return token;

  // Exceptionally large text sort keys do not fit safely in URLs. A signed
  // offset continuation keeps the result pageable without weakening normal
  // keyset pagination or accepting an arbitrary client-provided offset.
  const offsetToken = serialize(null);
  if (offsetToken.length > MAX_GQL_RESULT_CURSOR_LENGTH) {
    throw new Error("GQL cursor metadata exceeds the supported token size");
  }
  return offsetToken;
};

export const decodeDslResultCursor = (token: string | null | undefined, signingKey: string): DslResultCursor | null => {
  if (!token || !signingKey || token.length > MAX_GQL_RESULT_CURSOR_LENGTH) return null;
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(signatureFor(payload, signingKey), "utf8");
    const received = Buffer.from(signature, "utf8");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SerializedDslResultCursor>;
    if (
      parsed.v !== 1 ||
      typeof parsed.f !== "string" ||
      parsed.f.length === 0 ||
      !Number.isSafeInteger(parsed.s) ||
      parsed.s! < 0 ||
      !Number.isInteger(parsed.n) ||
      parsed.n! < 1 ||
      parsed.n! > 10_000 ||
      !(parsed.x === null || Array.isArray(parsed.x))
    ) {
      return null;
    }
    return {
      fingerprint: parsed.f,
      start: parsed.s!,
      pageSize: parsed.n!,
      values: parsed.x ?? null,
    };
  } catch {
    return null;
  }
};
