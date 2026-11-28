import { Empty, Failed, type NavProps, useLocale } from "@k2b/ui/v2";
import AreaFrame from "../_area/AreaFrame";
import type { AiAreaSection } from "./area";
import { aiAreaLink, aiSectionLabel } from "./frame";
import { aiAreaMessages } from "./messages";

/**
 * A section that cannot show its content: the person is no administrator (the way back to the start), or the catalog
 * could not be read (try again; nothing changed). The admin bar stays, so every other place is one step away.
 */
export default function AiStateScreen(props: { nav: NavProps; section: AiAreaSection; kind: "noPermission" | "failed" }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  return (
    <AreaFrame nav={props.nav} area={aiAreaLink(locale())} title={aiSectionLabel(locale(), props.section)}>
      {props.kind === "noPermission" ? (
        <Empty icon="lock" text={`${t().nopermTitle}. ${t().nopermSub}`} action={{ label: t().toStart, href: "/" }} />
      ) : (
        <Failed text={`${t().loadFailTitle}. ${t().loadFailSub}`} onRetry={() => window.location.reload()} />
      )}
    </AreaFrame>
  );
}
