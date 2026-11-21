import type { CodeCheckDiagnostic, CodePermission, CodeVersionManifest } from "@k2b/cloud/code";
import type { CapabilityManifest } from "@k2b/cloud/contracts";
import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      refused: ({ type }: { type: string }) =>
        `A public route cannot read ${type}. Its app keeps this data off pages without sign-in, also with audience "owner-data". Serve the page to members instead.`,
    },
    de: {
      refused: ({ type }) =>
        `Eine öffentliche Route kann ${type} nicht lesen. Die App hält diese Daten von Seiten ohne Anmeldung fern, auch mit audience "owner-data". Stelle die Seite stattdessen für Mitglieder bereit.`,
    },
  },
});

/**
 * G1 for the checker: a public route never reads a type its app declares in `code.noPublicRoutes`, through a Query's
 * target or ref, or by calling the type's reader. A call the checker could not place in an entrypoint counts for every
 * public route. One diagnostic per refused call; an empty list means the version may be submitted.
 */
export function publicRouteReadRefusals(
  manifest: Pick<CodeVersionManifest, "entrypoints">,
  permissions: readonly CodePermission[],
  catalogs: ReadonlyMap<string, Pick<CapabilityManifest, "appId" | "types" | "queries" | "code"> | null | undefined>,
  locale: string | undefined,
): CodeCheckDiagnostic[] {
  const publicRoutes = new Set(manifest.entrypoints.filter((entry) => entry.route?.public).map((entry) => entry.entrypoint));
  if (publicRoutes.size === 0) return [];
  const { t } = messages.resolve(locale ? [locale] : []);
  const diagnostics: CodeCheckDiagnostic[] = [];
  for (const permission of permissions) {
    if (permission.entrypoints && !permission.entrypoints.some((entry) => publicRoutes.has(entry))) continue;
    const appId = permission.operation.split(".")[0]!;
    const localId = permission.operation.slice(appId.length + 1);
    const operationApp = catalogs.get(appId);
    if (!operationApp?.queries.some((query) => query.localId === localId)) continue;
    const readType = permission.target
      ? permission.target.type
      : (() => {
          const type = operationApp.types.find((candidate) => candidate.reader === localId);
          return type ? `${appId}.${type.localId}` : null;
        })();
    if (!readType) continue;
    const typeAppId = readType.split(".")[0]!;
    const typeApp = catalogs.get(typeAppId);
    if (!typeApp?.code?.noPublicRoutes?.includes(readType.slice(typeAppId.length + 1))) continue;
    diagnostics.push({
      code: "code_public_route_private_data",
      message: t.refused({ type: readType }),
      file: permission.file,
      line: permission.line,
      column: 1,
    });
  }
  return diagnostics;
}
