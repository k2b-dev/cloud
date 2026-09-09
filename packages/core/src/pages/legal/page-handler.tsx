/**
 * Generic public page handler for the three legal documents
 * (Terms / Privacy / Imprint), driven by the `legal.<kind>.*` settings.
 *
 * mode = "local"    → render markdown from `legal.<kind>.content`
 * mode = "external" → 302-redirect to `legal.<kind>.url`
 *
 * One small helper, three mounts in Core's page router — KISS.
 */

import { MarkdownView, Placeholder } from "@k2b/ui";
import { coreSettings } from "@k2b/cloud/services";
import { markdown } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { getLocale } from "@k2b/cloud/server";
import { ssr } from "../../config";
import { corePageMessages } from "../messages";

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
    const html = trimmedContent ? markdown.render(trimmedContent) : null;

    return () => (
      <Layout c={c} title={title}>
        <div class="container max-w-3xl p-4 sm:p-8">
          <h1 class="text-xl font-bold mb-4">{title}</h1>
          {html ? (
            <MarkdownView trustedHtml={html} />
          ) : (
            <Placeholder
              surface="paper"
              description={
                <>
                  {t.legalNotConfigured({ title })}{" "}
                  <a href="/admin/settings?tab=legal" class="underline">
                    /admin/settings
                  </a>
                  .
                </>
              }
            />
          )}
        </div>
      </Layout>
    );
  });
