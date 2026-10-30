/**
 * Environment registry factory.
 *
 * Every runtime environment variable is declared once with a schema, a
 * default, a scope and a one-sentence doc. Registries read `process.env`
 * lazily: each key is parsed on access, so tests can change variables and
 * consumers never depend on an import-time snapshot. Configured secret files
 * are also validated when the registry is created. `.env.example`,
 * `.env.prod.example` and the configuration reference are generated from the
 * `$specs` of every registry by `scripts/generate-config-docs.ts`.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * `runtime` is read by deployed processes, `secret` is a runtime credential,
 * `development` only matters for host-run development, builds or tooling.
 */
export type EnvScope = "runtime" | "secret" | "development";

export type EnvSpec<T> = {
  /** Parses the raw value (trimmed for env, one trailing newline removed for files). Empty and unset values never reach the schema. */
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
  /** Allow NAME_FILE to supply the secret. Configured files are validated when the registry is created. */
  secretFile?: boolean;
};

export type EnvSpecs = Record<string, EnvSpec<unknown>>;

type EnvValue<S extends EnvSpec<unknown>> = S extends { default: unknown } | { required: true }
  ? z.output<S["schema"]>
  : z.output<S["schema"]> | undefined;

export type EnvRegistry<S extends EnvSpecs> = { readonly [K in keyof S]: EnvValue<S[K]> } & {
  readonly $specs: S;
  readonly $keys: readonly string[];
  /** Read only an explicitly supplied value, without the code default. */
  readonly $readPresent: <K extends keyof S & string>(key: K) => z.output<S[K]["schema"]> | undefined;
};

/** Effective value source; empty values fall through to the default or unset. */
export type EnvSource = "env" | "alias" | "file" | "default" | "unset";

type RawEnv = { value: string | undefined; source: "env" | "alias" | "file" | "unset" };

// A mounted secret is a startup input, not a live configuration channel. A new
// path is still observed when tests or tooling deliberately change process.env.
const fileValues = new WeakMap<EnvSpec<unknown>, { path: string; value: string }>();

const rawValue = (key: string, spec: EnvSpec<unknown>): RawEnv => {
  const names = [key, ...(spec.aliases ?? [])];
  const fileKey = `${key}_FILE`;
  const path = spec.secretFile ? process.env[fileKey]?.trim() || undefined : undefined;
  if (path !== undefined) {
    const conflict = names.find((name) => process.env[name]?.trim());
    if (conflict) throw new Error(`${conflict} and ${fileKey} must not both be set`);
    const cached = fileValues.get(spec);
    let value = cached?.path === path ? cached.value : undefined;
    if (value === undefined) {
      try {
        value = readFileSync(path, "utf8");
      } catch {
        // File errors must identify the source without including contents or an underlying error.
        throw new Error(`${fileKey} could not read file ${JSON.stringify(path)}`);
      }
      if (value.endsWith("\r\n")) value = value.slice(0, -2);
      else if (value.endsWith("\n")) value = value.slice(0, -1);
      fileValues.set(spec, { path, value });
    }
    return { value: value === "" ? undefined : value, source: value === "" ? "unset" : "file" };
  }
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { value, source: name === key ? "env" : "alias" };
  }
  return { value: undefined, source: "unset" };
};

/** Inspect the effective source without evaluating defaults; invalid file configuration throws as on value access. */
export const envSource = <S extends EnvSpecs>(registry: EnvRegistry<S>, key: keyof S & string): EnvSource => {
  const spec = registry.$specs[key]!;
  const { source } = rawValue(key, spec);
  return source === "unset" && spec.default !== undefined ? "default" : source;
};

const isFactory = <T>(value: T | (() => T)): value is () => T => typeof value === "function";

export const readEnv = <T>(key: string, spec: EnvSpec<T>): T | undefined => {
  const { value: raw } = rawValue(key, spec);
  if (raw === undefined) {
    if (spec.default !== undefined) return isFactory(spec.default) ? spec.default() : spec.default;
    if (spec.required) throw new Error(`${key} is required`);
    return undefined;
  }
  const parsed = spec.schema.safeParse(raw);
  if (!parsed.success) {
    if (spec.secretFile) throw new Error(`${key} is invalid`);
    const reason = parsed.error.issues.map((issue) => issue.message).join("; ") || "is invalid";
    throw new Error(`${key} ${reason}`);
  }
  return parsed.data;
};

export const defineEnv = <S extends EnvSpecs>(specs: S): EnvRegistry<S> => {
  const keys = Object.freeze(Object.keys(specs));
  const registry: Record<string, unknown> = {
    $specs: specs,
    $keys: keys,
    $readPresent: (key: string) => {
      const spec = specs[key];
      if (!spec) throw new Error(`Unknown environment variable: ${key}`);
      return readEnv(key, { ...spec, default: undefined, required: false });
    },
  };
  for (const key of keys) {
    const spec = specs[key]!;
    // Fail during module initialization, even when this secret is first used by a later request.
    if (spec.secretFile && process.env[`${key}_FILE`]?.trim()) readEnv(key, spec);
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
