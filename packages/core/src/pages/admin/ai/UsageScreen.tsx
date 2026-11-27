import { Empty, type NavProps, useLocale } from "@k2b/ui/v2";
import AreaFrame from "../_area/AreaFrame";
import type { AiUsageData } from "./insight-data";
import { aiAreaLink, aiSectionLabel } from "./frame";

/** Placeholder while this section moves to v2; its builder replaces this file. */
export default function UsageScreen(props: { nav: NavProps; data: AiUsageData }) {
  const locale = useLocale();
  return (
    <AreaFrame nav={props.nav} area={aiAreaLink(locale())} title={aiSectionLabel(locale(), "usage")}>
      <Empty icon="chart-histogram" text={String(Object.keys(props.data).length)} />
    </AreaFrame>
  );
}
