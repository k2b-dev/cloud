import type { CodeCheckDiagnostic, CodePermission, CodeVersionManifest } from "@k2b/cloud/code";
import type { CapabilityManifest } from "@k2b/cloud/contracts";
import { i18n } from "@k2b/stdlib";
import { isCodeAiOperation } from "./policy-contracts";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      app: ({ operation }: { operation: string }) =>
        `A public route cannot call ${operation}. Its app keeps its data off pages without sign-in, also with audience "owner-data". Serve the page to members instead.`,
      ownerData: ({ operation }: { operation: string }) =>
        `A public route that calls ${operation} shows data read with the owner's rights to everyone. Declare { public: true, audience: "owner-data" } if that is intended, or serve the page to members.`,
      database:
        'This Code has its own database, which may hold app data that this or an earlier version copied, so its public route may show it to everyone. Declare { public: true, audience: "owner-data" } if that is intended, or serve the page to members.',
    },
    de: {
      app: ({ operation }) =>
        `Eine öffentliche Route kann ${operation} nicht aufrufen. Die App hält ihre Daten von Seiten ohne Anmeldung fern, auch mit audience "owner-data". Stelle die Seite stattdessen für Mitglieder bereit.`,
      ownerData: ({ operation }) =>
        `Eine öffentliche Route, die ${operation} aufruft, zeigt allen Daten mit den Rechten des Besitzers. Deklariere { public: true, audience: "owner-data" }, wenn das gewollt ist, oder stelle die Seite für Mitglieder bereit.`,
      database:
        'Dieser Code hat eine eigene Datenbank, die App-Daten enthalten kann, die diese oder eine frühere Version kopiert hat. Seine öffentliche Route könnte sie allen zeigen. Deklariere { public: true, audience: "owner-data" }, wenn das gewollt ist, oder stelle die Seite für Mitglieder bereit.',
    },
  },
});

/** The Code's own database and files belong to the Code, not to an app. */
const isCodeOwnData = (operation: string) => operation === "db.query" || operation.startsWith("core.code.file.");
/** AI reads no resource by itself; a resource it is given is a target or ref and counts on its own. */
const isUnnamedRead = (permission: CodePermission) =>
  isCodeOwnData(permission.operation) || (isCodeAiOperation(permission.operation) && !permission.target);

/**
 * G1 for the checker, in step with hosting: a public route has no visitor who could read anything, so every Query it
 * calls needs `audience: "owner-data"`, and a Query of an app with `code.publicRoutes: false` is refused even then.
 * A call the checker could not place in an entrypoint counts for every public route. One diagnostic per refused
 * call; an empty list means the version may be submitted.
 */
export function publicRouteReadRefusals(
  manifest: Pick<CodeVersionManifest, "entrypoints" | "database">,
  permissions: readonly CodePermission[],
  catalogs: ReadonlyMap<string, Pick<CapabilityManifest, "appId" | "queries" | "code"> | null | undefined>,
  locale: string | undefined,
): CodeCheckDiagnostic[] {
  const publicRoutes = new Map(
    manifest.entrypoints.flatMap((entry) =>
      entry.route?.public ? [[entry.entrypoint, entry.route.audience === "owner-data"] as const] : [],
    ),
  );
  if (publicRoutes.size === 0) return [];
  const { t } = messages.resolve(locale ? [locale] : []);
  const diagnostics: CodeCheckDiagnostic[] = [];
  for (const permission of permissions) {
    const routes = permission.entrypoints ? permission.entrypoints.filter((entry) => publicRoutes.has(entry)) : [...publicRoutes.keys()];
    if (routes.length === 0 || isUnnamedRead(permission)) continue;
    const appId = permission.operation.split(".")[0]!;
    const app = catalogs.get(appId);
    if (!app?.queries.some((query) => query.localId === permission.operation.slice(appId.length + 1))) continue;
    const message =
      app.code?.publicRoutes === false
        ? t.app({ operation: permission.operation })
        : routes.some((entry) => !publicRoutes.get(entry))
          ? t.ownerData({ operation: permission.operation })
          : null;
    if (message) diagnostics.push({ code: "code_public_route_reads", message, file: permission.file, line: permission.line, column: 1 });
  }
  // The Code's database outlives its versions: app data an earlier version copied into it is still app data.
  if (manifest.database)
    for (const entry of manifest.entrypoints)
      if (entry.route?.public && entry.route.audience !== "owner-data")
        diagnostics.push({ code: "code_public_route_reads", message: t.database, file: entry.file, line: entry.line, column: 1 });
  return diagnostics;
}
