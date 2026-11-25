import { listApps } from "@k2b/cloud";
import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { coreSettings, settingsListLegacyKeys } from "@k2b/cloud/services";
import { geoAdmin } from "@k2b/cloud/services/geo/admin";
import { formatDateTime } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import type { RegistryFormSection } from "../_area/RegistryForm";
import PlacesAndMaps from "../places-and-maps/PlacesAndMaps.island";
import { settingsDocumentationHref } from "../settings/documentation";
import { buildEntries } from "../settings/entries";
import { type BaseSection, baseNav, baseText } from "./area";
import BaseScreen from "./BaseScreen.island";
import { cliSections, generalSections, legalSections, pdfSections } from "./sections";

/** One registry form as a section of the Base settings area. General also reads the stored settings no app declares. */
const formSection = (section: Exclude<BaseSection, "places">, groups: string[], sections: (locale: string) => RegistryFormSection[]) =>
  ssr<AuthContext>(async (c) => {
    const locale = getLocale(c);
    const [entries, documentationBase, legacy] = await Promise.all([
      Promise.all(groups.map((group) => buildEntries(group, locale))).then((lists) => lists.flat()),
      coreSettings.get<string>("app.documentation_url"),
      section === "general"
        ? listApps().then((apps) => settingsListLegacyKeys(apps.flatMap((app) => [...(app.settingKeys ?? [])])))
        : Promise.resolve(undefined),
    ]);
    const dates = { ...getDateConfig(c), locale };
    return () => (
      <AdminLayout c={c} ui="v2" title={baseText(locale)[section]}>
        <BaseScreen
          nav={baseNav(c, locale, section)}
          section={section}
          documentationHref={settingsDocumentationHref(documentationBase, section)}
          groups={groups}
          sections={sections(locale)}
          entries={entries}
          legacy={legacy?.map((item) => ({ ...item, updated: formatDateTime(item.updatedAt, dates) }))}
        />
      </AdminLayout>
    );
  });

export const generalPage = formSection("general", ["app", "outgoing_mail", "gateway"], generalSections);
export const legalPage = formSection("legal", ["legal"], legalSections);
export const pdfPage = formSection("pdf", ["gotenberg"], pdfSections);
export const cliPage = formSection("cli", ["cli"], cliSections);

/** Places & maps keeps its own flow: the key is tested before it applies, and the budget saves as one pair. */
export const placesPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const user = c.get("user");
  const [status, usage, documentationBase] = await Promise.all([
    geoAdmin.status(user).catch(() => null),
    geoAdmin.usage(user).catch(() => null),
    coreSettings.get<string>("app.documentation_url"),
  ]);
  return () => (
    <AdminLayout c={c} ui="v2" title={baseText(locale).places}>
      <PlacesAndMaps
        nav={baseNav(c, locale, "places")}
        documentationHref={settingsDocumentationHref(documentationBase, "places")}
        initial={{ status, usage, actorId: user.id }}
      />
    </AdminLayout>
  );
});
