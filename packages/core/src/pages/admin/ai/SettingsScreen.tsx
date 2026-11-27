import { Empty, type NavProps, useLocale } from "@k2b/ui/v2";
import AreaFrame from "../_area/AreaFrame";
import type { AiSettingsData } from "./settings-data";
import { aiAreaLink, aiSectionLabel } from "./frame";

/** Placeholder while this section moves to v2; its builder replaces this file. */
export default function SettingsScreen(props: { nav: NavProps; data: AiSettingsData }) {
  const locale = useLocale();
  return (
    <AreaFrame nav={props.nav} area={aiAreaLink(locale())} title={aiSectionLabel(locale(), "general")}>
      <Empty icon="adjustments" text={String(Object.keys(props.data).length)} />
    </AreaFrame>
  );
}
