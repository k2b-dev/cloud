import { Empty, type NavProps, useLocale } from "@k2b/ui/v2";
import AreaFrame from "../_area/AreaFrame";
import type { AiProvidersData } from "./catalog-data";
import { aiAreaLink, aiSectionLabel } from "./frame";

/** Placeholder while this section moves to v2. */
export default function ProvidersScreen(props: { nav: NavProps; data: AiProvidersData; }) {
  const locale = useLocale();
  return (
    <AreaFrame nav={props.nav} area={aiAreaLink(locale())} title={aiSectionLabel(locale(), "providers")}>
      <Empty icon="plug-connected" text={String(Object.keys(props.data).length)} />
    </AreaFrame>
  );
}
