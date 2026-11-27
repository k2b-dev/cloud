import { Empty, type NavProps, useLocale } from "@k2b/ui/v2";
import AreaFrame from "../_area/AreaFrame";
import type { AiProjectsData } from "./content-data";
import { aiAreaLink, aiSectionLabel } from "./frame";

/** Placeholder while this section moves to v2; its builder replaces this file. */
export default function ProjectsScreen(props: { nav: NavProps; data: AiProjectsData }) {
  const locale = useLocale();
  return (
    <AreaFrame nav={props.nav} area={aiAreaLink(locale())} title={aiSectionLabel(locale(), "projects")}>
      <Empty icon="folders" text={String(Object.keys(props.data).length)} />
    </AreaFrame>
  );
}
