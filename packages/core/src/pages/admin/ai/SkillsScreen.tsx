import { Empty, type NavProps, useLocale } from "@k2b/ui/v2";
import AreaFrame from "../_area/AreaFrame";
import type { AiSkillsData } from "./content-data";
import { aiAreaLink, aiSectionLabel } from "./frame";

/** Placeholder while this section moves to v2; its builder replaces this file. */
export default function SkillsScreen(props: { nav: NavProps; data: AiSkillsData }) {
  const locale = useLocale();
  return (
    <AreaFrame nav={props.nav} area={aiAreaLink(locale())} title={aiSectionLabel(locale(), "skills")}>
      <Empty icon="wand" text={String(Object.keys(props.data).length)} />
    </AreaFrame>
  );
}
