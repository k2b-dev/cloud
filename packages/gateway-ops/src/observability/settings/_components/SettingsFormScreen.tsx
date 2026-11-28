import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, type NavProps, Pane } from "@k2b/ui/v2";
import { areaMessages } from "../../_components/area-messages";
import { SettingsSaveBar } from "../../_components/SettingsSaveBar";
import GeneralForm, { type GeneralValues } from "../GeneralForm";
import { SettingsTabs } from "./SettingsTabs";

export type SettingsFormScreenProps = {
  nav: NavProps;
  values: GeneralValues;
  unreadable: Partial<Record<keyof GeneralValues, boolean>>;
};

/** The health check and the retention of operational data: one form in two sections, saved once from the head. */
export default function SettingsFormScreen(props: SettingsFormScreenProps) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  return (
    <AdminWorkspace nav={props.nav} head={<Bar start={<SettingsTabs current="general" />} end={<SettingsSaveBar />} />}>
      <Pane label={t().generalShort}>
        <GeneralForm values={props.values} unreadable={props.unreadable} />
      </Pane>
    </AdminWorkspace>
  );
}
