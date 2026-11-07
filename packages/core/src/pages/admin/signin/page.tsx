import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { appApproval, coreSettings, geoip, linuxIdentities } from "@k2b/cloud/services";
import { AdminAreaPane } from "@k2b/cloud/ssr";
import { z } from "zod";
import { ssr } from "../../../config";
import { approvalAvailability } from "../../app-approval/availability";
import type { RegistryFormSection } from "../_area/RegistryForm.island";
import AccountOperations from "../settings/_components/AccountOperations.island";
import DocumentationLink from "../settings/_components/DocumentationLink";
import LinuxIdentityPanel from "../settings/_components/LinuxIdentityPanel.island";
import { buildEntries } from "../settings/entries";
import { SigninArea, signinText } from "./area";
import { freeipaSections, registrationSections, securitySections, signinSections } from "./sections";
import { SigninFormView } from "./view";

type FormSection = "signin" | "registration" | "security" | "freeipa";

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
      <SigninFormView
        c={c}
        locale={locale}
        section={section}
        groups={[group]}
        sections={shown}
        entries={entries.filter((entry) => keys.has(entry.key))}
        documentationBase={documentationBase}
        approvalState={section === "signin" ? approvalAvailability(approval ?? null) : undefined}
        signInLocations={section === "signin" ? { status: locations ?? null, actorId: user.id } : undefined}
      />
    );
  });

export const signinPage = formSection("signin", "user", signinSections);
export const registrationPage = formSection("registration", "user", registrationSections);
export const securityPage = formSection("security", "security", securitySections);
export const freeipaPage = formSection("freeipa", "freeipa", freeipaSections);

export const linuxPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = signinText(locale);
  const cursor = z.uuid().safeParse(c.req.query("after"));
  const after = cursor.success ? cursor.data : null;
  const search = (c.req.query("search") ?? "").trim();
  const scope = c.req.query("scope") === "all" ? "all" : "ready";
  const [overview, documentationBase] = await Promise.all([
    linuxIdentities.overview(c.get("user"), after, { search, scope }),
    coreSettings.get<string>("app.documentation_url"),
  ]);
  return () => (
    <SigninArea c={c} locale={locale} section="linux">
      <AdminAreaPane
        label={t.linux}
        description={t.linuxDescription}
        actions={<DocumentationLink base={documentationBase} topic="linux" />}
      >
        <LinuxIdentityPanel initial={overview} after={after} search={search} scope={scope} documentationBase={documentationBase} embedded />
      </AdminAreaPane>
    </SigninArea>
  );
});

export const operationsPage = ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = signinText(locale);
  const [freeIpaEnabled, documentationBase] = await Promise.all([
    coreSettings.get<boolean>("freeipa.enable"),
    coreSettings.get<string>("app.documentation_url"),
  ]);
  return () => (
    <SigninArea c={c} locale={locale} section="operations">
      <AdminAreaPane
        label={t.operations}
        description={t.operationsDescription}
        actions={<DocumentationLink base={documentationBase} topic="account-operations" />}
      >
        <AccountOperations freeIpaEnabled={freeIpaEnabled} />
      </AdminAreaPane>
    </SigninArea>
  );
});
