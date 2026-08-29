/**
 * Type-level scaffolding for `defineApp({ settings: { ... } })`.
 *
 * These types let TypeScript derive a per-app `Settings` shape from the literal
 * settings declaration in defineApp. The derived shape is:
 *
 *   1. **Flat** — `{ "files.filegate_url": string, "freeipa.enable": boolean, ... }`
 *      (used by the typed async API: `app.settings.get("files.filegate_url")`)
 *
 *   2. **Nested + readonly** — `{ files: { filegate_url: string }, freeipa: { enable: boolean } }`
 *      (used by the per-request snapshot exposed via `c.get("settings")`)
 *
 * No runtime in this file — pure TypeScript.
 */
import type { SettingOption } from "../services/settings/defaults";

// ── Setting definition shape (what users write inside defineApp.settings) ───

type EnvResolver = () => unknown;

export type AppSettingPresentationTranslation = {
  label?: string;
  description?: string;
  placeholder?: string;
  options?: Readonly<Record<string, string>>;
};

export type AppSettingPresentation = {
  /** Partial overlays; the complete fields use the application's presentation base locale. */
  translations: Readonly<Record<string, AppSettingPresentationTranslation>>;
};

type CommonDef = {
  label?: string;
  description?: string;
  presentation?: AppSettingPresentation;
  envBootstrap?: EnvResolver;
  envFallback?: EnvResolver;
};

type StringLikeKind = "string" | "text" | "email" | "url" | "secret" | "image" | "cron" | "timezone" | "template";

export type AppSettingDef =
  | (CommonDef & { kind: StringLikeKind; default: string; placeholder?: string; templateVars?: readonly string[] })
  | (CommonDef & { kind: "boolean"; default: boolean })
  | (CommonDef & { kind: "number"; default: number; min?: number; max?: number; placeholder?: string })
  | (CommonDef & { kind: "enum"; default: string; options: ReadonlyArray<SettingOption> })
  | (CommonDef & { kind: "string_list"; default: readonly string[]; placeholder?: string })
  | (CommonDef & { kind: "number_list"; default: readonly number[]; placeholder?: string });

/** A map of setting-key → definition. The key strings are dotted paths like "files.filegate_url". */
export type AppSettingsMap = Record<string, AppSettingDef>;

// ── Type-level transforms ───────────────────────────────────────────────────

/** Map a setting `kind` literal to the runtime value type returned by reads. */
export type KindToType<K extends string> = K extends "boolean"
  ? boolean
  : K extends "number"
    ? number
    : K extends "string_list"
      ? string[]
      : K extends "number_list"
        ? number[]
        : string;

/**
 * Derive a flat `{ key: value }` map from a SettingsMap.
 *
 * Example:
 *   SettingsFlat<{ "app.name": { kind: "string"; default: "" } }>
 *   = { readonly "app.name": string }
 */
export type SettingsFlat<S extends Record<string, { kind: string }>> = {
  readonly [K in keyof S]: KindToType<S[K]["kind"]>;
};

/**
 * Recursively un-flatten dotted-key maps into nested objects.
 *
 * Example:
 *   Unflatten<{ "files.filegate_url": string; "files.base_homes": string; "app.name": string }>
 *   = { readonly files: { readonly filegate_url: string; readonly base_homes: string }, readonly app: { readonly name: string } }
 */
export type Unflatten<T extends Record<string, unknown>> = {
  readonly [K in Extract<keyof T, string> as K extends `${infer Head}.${string}` ? Head : K]: K extends `${infer Head}.${string}`
    ? Unflatten<{ [P in Extract<keyof T, `${Head}.${string}`> as P extends `${Head}.${infer R}` ? R : never]: T[P] }>
    : T[K];
};

/**
 * Final per-app Settings shape: nested, readonly, derived from the App type.
 *
 * Used by `AppContext<App>` to type `c.get("settings")` correctly per-app.
 */
export type AppSettings<App> = App extends { readonly _settings: infer S extends Record<string, { kind: string }> }
  ? Unflatten<SettingsFlat<S>>
  : never;
