import { Empty, type NavProps, useLocale } from "@k2b/ui/v2";
import AreaFrame from "../_area/AreaFrame";
import type { AiPeopleData } from "./insight-data";
import { aiAreaLink, aiSectionLabel } from "./frame";

/** Placeholder while this section moves to v2; its builder replaces this file. */
export default function PeopleScreen(props: { nav: NavProps; data: AiPeopleData }) {
  const locale = useLocale();
  return (
    <AreaFrame nav={props.nav} area={aiAreaLink(locale())} title={aiSectionLabel(locale(), "budgets")}>
      <Empty icon="users" text={String(Object.keys(props.data).length)} />
    </AreaFrame>
  );
}
