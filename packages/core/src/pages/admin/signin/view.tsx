import type { GeoIpAdminStatus } from "@k2b/cloud/contracts";
import { AdminAreaPane } from "@k2b/cloud/ssr";
import { SettingsSection } from "@k2b/ui";
import ApprovalStatus from "../../app-approval/ApprovalStatus";
import type { ApprovalAvailability } from "../../app-approval/availability";
import RegistryForm, { type RegistryFormSection } from "../_area/RegistryForm.island";
import DocumentationLink from "../settings/_components/DocumentationLink";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { SigninArea, type SigninSection, signinText } from "./area";
import SignInLocationsIsland from "./SignInLocations.island";
import TestFreeIpaButton from "./TestFreeIpaButton.island";

/** Guide topics of the sections, as the settings pages had them. */
const TOPIC: Partial<Record<SigninSection, string>> = { signin: "user", registration: "registration", freeipa: "freeipa" };

/** A registry form section of the Sign-in & security area. Sign-in adds the app sign-in state and sign-in locations. */
export function SigninFormView(props: {
  c: Parameters<typeof SigninArea>[0]["c"];
  locale: string;
  section: "signin" | "registration" | "security" | "freeipa";
  groups: string[];
  sections: RegistryFormSection[];
  entries: SettingFieldDef[];
  documentationBase?: string;
  approvalState?: ApprovalAvailability;
  signInLocations?: { status: GeoIpAdminStatus | null; actorId: string };
}) {
  const t = signinText(props.locale);
  const topic = TOPIC[props.section];
  return (
    <SigninArea c={props.c} locale={props.locale} section={props.section}>
      <AdminAreaPane
        label={t[props.section]}
        description={t[`${props.section}Description`]}
        saveStatus
        actions={
          <>
            {topic ? <DocumentationLink base={props.documentationBase} topic={topic} /> : null}
            {props.section === "freeipa" ? <TestFreeIpaButton /> : null}
          </>
        }
      >
        <RegistryForm groups={props.groups} sections={props.sections} entries={props.entries} />
        {props.approvalState ? (
          <SettingsSection title={t.approvalState}>
            <ApprovalStatus state={props.approvalState} admin />
          </SettingsSection>
        ) : null}
        {props.signInLocations ? (
          <SignInLocationsIsland status={props.signInLocations.status} actorId={props.signInLocations.actorId} />
        ) : null}
      </AdminAreaPane>
    </SigninArea>
  );
}
