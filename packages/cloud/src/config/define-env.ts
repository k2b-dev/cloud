/**
 * Environment registry factory.
 *
 * Every runtime environment variable is declared once with a schema, a
 * default, a scope and a one-sentence doc. Registries read `process.env`
 * lazily: each key is parsed on access, so tests can change variables and
 * consumers never depend on an import-time snapshot. `.env.example`,
 * `.env.prod.example` and the configuration reference are generated from the
 * `$specs` of every registry by `scripts/generate-config-docs.ts`.
 */
import { z } from "zod";

/**
 * `runtime` is read by deployed processes, `secret` is a runtime credential,
 * `development` only matters for host-run development, builds or tooling.
 */
export type EnvScope = "runtime" | "secret" | "development";

export type EnvSpec<T> = {
  /** Parses the trimmed raw value. Empty and unset values never reach the schema. */
  schema: z.ZodType<T, unknown>;
  /** Used when the variable is unset or empty; a function is evaluated on every access. */
  default?: T | (() => T);
  /** One sentence for operators; rendered into the generated files. */
  doc: string;
  /** Default `runtime`. */
  scope?: EnvScope;
  /** Host-run development value written to `.env.example`. */
  example?: string;
  /** Throw on access when unset and no default exists. */
  required?: boolean;
  /** Alternative variable names, consulted after the canonical key. */
  aliases?: string[];
};

export type EnvSpecs = Record<string, EnvSpec<unknown>>;

type EnvValue<S extends EnvSpec<unknown>> = S extends { default: unknown } | { required: true }
  ? z.output<S["schema"]>
  : z.output<S["schema"]> | undefined;

export type EnvRegistry<S extends EnvSpecs> = { readonly [K in keyof S]: EnvValue<S[K]> } & {
  readonly $specs: S;
  readonly $keys: readonly string[];
};

const rawValue = (key: string, aliases: string[] = []): string | undefined => {
  for (const name of [key, ...aliases]) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
};

const isFactory = <T>(value: T | (() => T)): value is () => T => typeof value === "function";

export const readEnv = <T>(key: string, spec: EnvSpec<T>): T | undefined => {
  const raw = rawValue(key, spec.aliases);
  if (raw === undefined) {
    if (spec.default !== undefined) return isFactory(spec.default) ? spec.default() : spec.default;
    if (spec.required) throw new Error(`${key} is required`);
    return undefined;
  }
  const parsed = spec.schema.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((issue) => issue.message).join("; ") || "is invalid";
    throw new Error(`${key} ${reason}`);
  }
  return parsed.data;
};

export const defineEnv = <S extends EnvSpecs>(specs: S): EnvRegistry<S> => {
  const keys = Object.freeze(Object.keys(specs));
  const registry: Record<string, unknown> = { $specs: specs, $keys: keys };
  for (const key of keys) {
    Object.defineProperty(registry, key, { enumerable: true, configurable: true, get: () => readEnv(key, specs[key]!) });
  }
  // The getters above are the only way to build a typed lazy object.
  return registry as EnvRegistry<S>;
};

/** Any non-empty string; empty values are treated as unset before parsing. */
export const envString = z.string();

/** `true` or `1` (case-insensitive) is true; everything else is false. */
export const envBoolean = z.string().transform((value) => {
  const normalized = value.toLowerCase();
  return normalized === "true" || normalized === "1";
});

/** Comma-separated entries; whitespace and empty entries are dropped. */
export const envList = z.string().transform((value) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
