import { Empty, type NavProps, useLocale } from "@k2b/ui/v2";
import AreaFrame from "../_area/AreaFrame";
import type { AiBudgetsData } from "./catalog-data";
import { aiAreaLink, aiSectionLabel } from "./frame";

/** Placeholder while this section moves to v2. */
export default function BudgetsScreen(props: { nav: NavProps; data: AiBudgetsData; rule: string | null; }) {
  const locale = useLocale();
  return (
    <AreaFrame nav={props.nav} area={aiAreaLink(locale())} title={aiSectionLabel(locale(), "budgets")}>
      <Empty icon="gauge" text={String(Object.keys(props.data).length)} />
    </AreaFrame>
  );
}
