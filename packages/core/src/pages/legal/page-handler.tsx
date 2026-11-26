/**
 * Generic public page handler for the three legal documents
 * (Terms / Privacy / Imprint), driven by the `legal.<kind>.*` settings.
 *
 * mode = "local"    → render markdown from `legal.<kind>.content`
 * mode = "external" → 302-redirect to `legal.<kind>.url`
 *
 * One small helper, three mounts in Core's page router — KISS.
 */

import { getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { Band, Empty, Prose } from "@k2b/ui/v2";
import { ssr } from "../../config";
import { corePageMessages } from "../messages";
import { VisitorPage } from "../VisitorPage";

type LegalKind = "terms" | "privacy" | "imprint";

type LegalMode = "local" | "external";

export const makeLegalPage = (kind: LegalKind) =>
  ssr(async (c) => {
    const t = corePageMessages.resolve([getLocale(c)]).t;
    const title = { terms: t.terms, privacy: t.privacy, imprint: t.imprint }[kind];
    const [rawMode, url, content] = await Promise.all([
      coreSettings.get<string>(`legal.${kind}.mode`),
      coreSettings.get<string>(`legal.${kind}.url`),
      coreSettings.get<string>(`legal.${kind}.content`),
    ]);
    const mode: LegalMode = rawMode === "external" ? "external" : "local";

    // External mode + URL set → redirect. Only valid escape from this handler.
    if (mode === "external" && url && url.trim().length > 0) {
      return c.redirect(url, 302);
    }

    const trimmedContent = (content ?? "").trim();
    const appName = (await coreSettings.get<string>("app.name")) || "My App";
    c.get("page").title = title;

    // A visitor page on v2 in one measure. The text is Markdown in `Prose`: raw HTML in it shows as text.
    return () => (
      <VisitorPage c={c} appName={appName} title={title}>
        {trimmedContent ? (
          <Band label={title}>
            <Prose markdown={trimmedContent} />
          </Band>
        ) : (
          <Empty icon="file-off" text={`${t.legalNotConfigured({ title })} /admin/base/legal.`} />
        )}
      </VisitorPage>
    );
  });
