import { useLocale } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import AreaFrame from "../_area/AreaFrame";
import RegistryForm, { type RegistryFormSection } from "../_area/RegistryForm";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { outgoingMailMessages } from "./messages";
import { OUTGOING_MAIL_HREF } from "./paths";

/** The email templates of Outgoing mail on v2: one registry form with the transactional mail bodies. */
export default function TemplatesScreen(props: {
  nav: NavProps;
  documentationHref?: string;
  sections: RegistryFormSection[];
  entries: SettingFieldDef[];
}) {
  const locale = useLocale();
  const t = () => outgoingMailMessages.resolve([locale()]).t;
  return (
    <AreaFrame
      nav={props.nav}
      area={{ label: t().title, href: OUTGOING_MAIL_HREF.profiles }}
      title={t().templates}
      description={t().templatesDescription}
      documentationHref={props.documentationHref}
    >
      <RegistryForm groups={["mail"]} sections={props.sections} entries={props.entries} />
    </AreaFrame>
  );
}
