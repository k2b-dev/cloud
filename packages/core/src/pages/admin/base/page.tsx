import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { geoAdmin } from "@k2b/cloud/services/geo/admin";
import { AdminAreaPane } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import type { RegistryFormSection } from "../_area/RegistryForm.island";
import PlacesAndMaps from "../places-and-maps/PlacesAndMaps.island";
import DocumentationLink from "../settings/_components/DocumentationLink";
import { buildEntries } from "../settings/entries";
import { BaseArea, type BaseSection, baseText } from "./area";
import { cliSections, generalSections, legalSections, pdfSections } from "./sections";
import { BaseFormView } from "./view";

/** One registry form as a section of the Base settings area. */
const formSection = (section: Exclude<BaseSection, "places">, groups: string[], sections: (locale: string) => RegistryFormSection[]) =>
  ssr<AuthContext>(async (c) => {
    const locale = getLocale(c);
    const [entries, documentationBase] = await Promise.all([
      Promise.all(groups.map((group) => buildEntries(group, locale))).then((lists) => lists.flat()),
      coreSettings.get<string>("app.documentation_url"),
    ]);
    return () => (
      <BaseFormView
        c={c}
        locale={locale}
        section={section}
        groups={groups}
        sections={sections(locale)}
        entries={entries}
        documentationBase={documentationBase}
      />
    );
  });

export const generalPage = formSection("general", ["app"], generalSections);
export const legalPage = formSection("legal", ["legal"], legalSections);
export const pdfPage = formSection("pdf", ["gotenberg"], pdfSections);
export const cliPage = formSection("cli", ["cli"], cliSections);

/** Places & maps keeps its own flow: the key is tested before it applies, and the budget saves as one pair. */
export const placesPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = baseText(locale);
  const user = c.get("user");
  const [status, usage, documentationBase] = await Promise.all([
    geoAdmin.status(user).catch(() => null),
    geoAdmin.usage(user).catch(() => null),
    coreSettings.get<string>("app.documentation_url"),
  ]);
  return () => (
    <BaseArea c={c} locale={locale} section="places">
      <AdminAreaPane
        label={t.places}
        description={t.placesDescription}
        actions={<DocumentationLink base={documentationBase} topic="places" />}
      >
        <PlacesAndMaps initial={{ status, usage, actorId: user.id }} documentationBase={documentationBase} embedded />
      </AdminAreaPane>
    </BaseArea>
  );
});
