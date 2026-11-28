import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { Empty, type NavProps, Pane } from "@k2b/ui/v2";
import { CodeHead, useCodeText } from "./parts";

/** A person without the Code policy admin right sees only that Cloud admins manage Code, and the way to the start. */
export default function NoAccessScreen(props: { nav: NavProps }) {
  const t = useCodeText();
  return (
    <AdminWorkspace nav={props.nav} head={<CodeHead section="approvals" />}>
      <Pane label={t().area}>
        <Empty icon="lock" text={`${t().nopermTitle}. ${t().nopermSub}`} action={{ label: t().toStart, href: "/" }} />
      </Pane>
    </AdminWorkspace>
  );
}
