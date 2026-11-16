import { createHash } from "node:crypto";

/** One request's page swap: the build that must match, and the path prefix whose links may swap. */
export type PageSwapRegistration = { build: string; scope?: string };

const registrations = new WeakMap<object, PageSwapRegistration>();

/** Register only requests of applications that opted into page swaps. Without `scope`, the app's route prefix is the scope. */
export const registerPageSwap = (context: object, build: string, scope?: string): void => {
  registrations.set(context, scope ? { build, scope } : { build });
};
export const getPageSwap = (context: object): PageSwapRegistration | undefined => registrations.get(context);

/** A `pageSwap` path: absolute, without a trailing slash, segments of letters, digits, `-`, `_` and `.`, or `:name`. */
const PATH_PATTERN = /^(?:\/(?::[A-Za-z][A-Za-z0-9_]*|[A-Za-z0-9._~-]+))+$/;

/** Throws for a path that `matchPageSwapScope` could not match exactly, so a typo fails at startup, not silently. */
export const assertPageSwapPaths = (paths: readonly string[]): void => {
  if (paths.length === 0) throw new Error("pageSwap: list at least one path, or set pageSwap: true");
  for (const path of paths)
    if (!PATH_PATTERN.test(path))
      throw new Error(`pageSwap: "${path}" is not an absolute path such as "/admin/code" or "/app/mail/:id/code"`);
};

/**
 * The concrete prefix of the request path that one of the opted-in paths covers, or undefined. `:name` stands for one
 * path segment, so `/app/mail/:id/code` covers `/app/mail/Ab12/code?tab=runs` and its sub-pages with the scope
 * `/app/mail/Ab12/code`. The most specific match wins.
 */
export const matchPageSwapScope = (paths: readonly string[], pathname: string): string | undefined => {
  const segments = pathname.split("/").slice(1);
  let best: string | undefined;
  for (const path of paths) {
    const pattern = path.split("/").slice(1);
    if (pattern.length > segments.length) continue;
    const matched = pattern.every((part, index) => {
      const segment = segments[index]!;
      return segment !== "" && (part.startsWith(":") || part === segment);
    });
    if (!matched) continue;
    const scope = `/${segments.slice(0, pattern.length).join("/")}`;
    if (!best || scope.length > best.length) best = scope;
  }
  return best;
};

export type PageSwapParts = {
  app: string | undefined;
  kind: "app" | "anonymous";
  user: string | null;
  appSession: boolean;
  locale: string;
  theme: "light" | "dark" | undefined;
  build: string;
  /** The request-scoped inputs of the shell that stays: navigation catalogs, profile, panel providers, announcements and Help. */
  shell: unknown;
};
/** Opaque identity of the document that stays around the replaced content column. */
export const pageSwapSignature = (parts: PageSwapParts): string =>
  createHash("sha256")
    .update(JSON.stringify([parts.app, parts.kind, parts.user, parts.appSession, parts.locale, parts.theme, parts.build, parts.shell]))
    .digest("hex")
    .slice(0, 32);
