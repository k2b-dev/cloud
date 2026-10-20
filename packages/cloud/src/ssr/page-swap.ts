import { createHash } from "node:crypto";

const builds = new WeakMap<object, string>();

/** Register only requests of applications that opted into page swaps. */
export const registerPageSwap = (context: object, build: string): void => {
  builds.set(context, build);
};
export const getPageSwapBuild = (context: object): string | undefined => builds.get(context);

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
