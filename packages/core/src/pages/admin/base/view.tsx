import { AdminAreaPane } from "@k2b/cloud/ssr";
import RegistryForm, { type RegistryFormSection } from "../_area/RegistryForm.island";
import DocumentationLink from "../settings/_components/DocumentationLink";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { BaseArea, type BaseSection, baseText } from "./area";
import LegacySettings from "./LegacySettings.island";
import TestPdfButton from "./TestPdfButton.island";

/** A registry form section of the Base settings area. General adds the stored settings no app declares any more. */
export function BaseFormView(props: {
  c: Parameters<typeof BaseArea>[0]["c"];
  locale: string;
  section: Exclude<BaseSection, "places">;
  groups: string[];
  sections: RegistryFormSection[];
  entries: SettingFieldDef[];
  /** The documentation website for the section's guide link. */
  documentationBase?: string;
}) {
  const t = baseText(props.locale);
  return (
    <BaseArea c={props.c} locale={props.locale} section={props.section}>
      <AdminAreaPane
        label={t[props.section]}
        description={t[`${props.section}Description`]}
        saveStatus
        actions={
          <>
            <DocumentationLink base={props.documentationBase} topic={props.section} />
            {props.section === "pdf" ? <TestPdfButton /> : null}
          </>
        }
      >
        <RegistryForm groups={props.groups} sections={props.sections} entries={props.entries} />
        {props.section === "general" ? <LegacySettings /> : null}
      </AdminAreaPane>
    </BaseArea>
  );
}
