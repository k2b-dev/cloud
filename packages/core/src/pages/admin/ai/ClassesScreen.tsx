import { Empty, type NavProps, useLocale } from "@k2b/ui/v2";
import AreaFrame from "../_area/AreaFrame";
import type { AiClassesData } from "./catalog-data";
import { aiAreaLink, aiSectionLabel } from "./frame";

/** Placeholder while this section moves to v2. */
export default function ClassesScreen(props: { nav: NavProps; data: AiClassesData; appNames: Record<string, string>; }) {
  const locale = useLocale();
  return (
    <AreaFrame nav={props.nav} area={aiAreaLink(locale())} title={aiSectionLabel(locale(), "classes")}>
      <Empty icon="stairs-up" text={String(Object.keys(props.data).length)} />
    </AreaFrame>
  );
}
