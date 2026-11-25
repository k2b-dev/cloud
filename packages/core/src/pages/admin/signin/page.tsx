import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { appApproval, coreSettings, geoip, linuxIdentities } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { z } from "zod";
import { ssr } from "../../../config";
import { approvalAvailability } from "../../app-approval/availability";
import type { RegistryFormSection } from "../_area/RegistryForm";
import { settingsDocumentationHref } from "../settings/documentation";
import { buildEntries } from "../settings/entries";
import { type SigninSection, signinNav, signinText } from "./area";
import LinuxScreen from "./Linux.island";
import { linuxQuery, parseLinuxAddress } from "./linux-query";
import OperationsScreen from "./Operations.island";
import SigninFormScreen from "./SigninForm.island";
import { freeipaSections, registrationSections, securitySections, signinSections } from "./sections";

type FormSection = "signin" | "registration" | "security" | "freeipa";

/** Guide topics of the sections, as the settings pages had them. */
const TOPIC: Partial<Record<SigninSection, string>> = {
  signin: "user",
  registration: "registration",
  freeipa: "freeipa",
  linux: "linux",
  operations: "account-operations",
};
const guide = (base: string | undefined, section: SigninSection) => {
  const topic = TOPIC[section];
  return topic ? settingsDocumentationHref(base, topic) : undefined;
};

/** One registry form as a section of the Sign-in & security area. */
const formSection = (section: FormSection, group: string, sections: (locale: string, base?: string) => RegistryFormSection[]) =>
  ssr<AuthContext>(async (c) => {
    const locale = getLocale(c);
    const user = c.get("user");
    const [entries, documentationBase, approval, locations] = await Promise.all([
      buildEntries(group, locale),
      coreSettings.get<string>("app.documentation_url"),
      section === "signin" ? appApproval.config(false).catch(() => null) : Promise.resolve(undefined),
      // The block shows its own error with a retry when the status cannot be read; the page still renders.
      section === "signin" ? geoip.status(user).catch(() => null) : Promise.resolve(undefined),
    ]);
    const shown = sections(locale, documentationBase);
    const keys = new Set(shown.flatMap((item) => item.keys));
    return () => (
      <AdminLayout c={c} ui="v2" title={signinText(locale)[section]}>
        <SigninFormScreen
          nav={signinNav(c, locale, section)}
          section={section}
          documentationHref={guide(documentationBase, section)}
          groups={[group]}
          sections={shown}
          entries={entries.filter((entry) => keys.has(entry.key))}
          approvalState={section === "signin" ? approvalAvailability(approval ?? null) : undefined}
          signInLocations={section === "signin" ? { status: locations ?? null, actorId: user.id } : undefined}
        />
      </AdminLayout>
    );
  });

export const signinPage = formSection("signin", "user", signinSections);
export const registrationPage = formSection("registration", "user", registrationSections);
export const securityPage = formSection("security", "security", securitySections);
export const freeipaPage = formSection("freeipa", "freeipa", freeipaSections);

export const linuxPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const query = linuxQuery(locale);
  const address = parseLinuxAddress(query, new URL(c.req.url).searchParams);
  // Addresses from before v2 (`search=`) open the same list.
  if (address.redirect) return c.redirect(address.redirect, 302);
  const cursor = z.uuid().safeParse(address.after);
  const after = cursor.success ? cursor.data : null;
  const [overview, documentationBase] = await Promise.all([
    linuxIdentities.overview(c.get("user"), after, { search: address.state.search ?? "", scope: address.state.filters.scope ?? "ready" }),
    coreSettings.get<string>("app.documentation_url"),
  ]);
  return () => (
    <AdminLayout c={c} ui="v2" title={signinText(locale).linux}>
      <LinuxScreen
        nav={signinNav(c, locale, "linux")}
        documentationHref={guide(documentationBase, "linux")}
        linux={{ initial: overview, state: address.state, after }}
      />
    </AdminLayout>
  );
});

export const operationsPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const [freeIpaEnabled, documentationBase] = await Promise.all([
    coreSettings.get<boolean>("freeipa.enable"),
    coreSettings.get<string>("app.documentation_url"),
  ]);
  return () => (
    <AdminLayout c={c} ui="v2" title={signinText(locale).operations}>
      <OperationsScreen
        nav={signinNav(c, locale, "operations")}
        documentationHref={guide(documentationBase, "operations")}
        freeIpaEnabled={freeIpaEnabled === true}
      />
    </AdminLayout>
  );
});
