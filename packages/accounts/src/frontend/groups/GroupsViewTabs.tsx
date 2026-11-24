import { ViewTabs } from "@k2b/ui";
import { relationsMessages } from "./relations/relations-messages";
import { RELATIONS_PATH } from "./relations/relations-view";

/** List and relations of groups; the relations are for administrators only. */
export default function GroupsViewTabs(props: { current: "list" | "relations"; locale: string }) {
  const { t } = relationsMessages.resolve([props.locale]);
  return (
    <ViewTabs
      label={t.groupViews}
      current={props.current}
      items={[
        { id: "list", label: t.list, href: "/app/accounts/groups", icon: "ti ti-list" },
        { id: "relations", label: t.relations, href: RELATIONS_PATH, icon: "ti ti-hierarchy-3" },
      ]}
    />
  );
}
