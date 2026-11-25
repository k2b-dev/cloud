import { swapPage } from "@k2b/ssr/nav";
import { Chip, FilterBar, Pane, StatusRow, Table } from "@k2b/ui/v2";
import { createMemo, createSignal } from "solid-js";
import AccountWorkspace, { useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import { type ActivityState, activityQuery } from "./activity-query";
import SecurityTabs from "./SecurityTabs";

/** One entry as the server formatted it, so the first paint and the live page agree. */
export type ActivityRow = { id: string; time: string; label: string; outcome: "allowed" | "denied" | "failed"; context: string | null };

/** `/me/security/activity` on v2: what happened on the account in the chosen time range, newest first. */
export default function ActivityScreen(props: { user: AccountUserView; appTab: boolean; state: ActivityState; rows: ActivityRow[] }) {
  const t = useAccountMessages();
  const query = createMemo(() => activityQuery(t()));
  const [state, setState] = createSignal(props.state);
  const outcome = (row: ActivityRow) =>
    row.outcome === "allowed" ? (
      <Chip status="ok">{t().outcomeAllowed}</Chip>
    ) : row.outcome === "denied" ? (
      <Chip status="warn">{t().outcomeDenied}</Chip>
    ) : (
      <Chip status="bad">{t().outcomeFailed}</Chip>
    );
  const count = () => t().activityCount({ count: props.rows.length });
  return (
    <AccountWorkspace user={props.user} active="security" appTab={props.appTab}>
      <Pane
        label={t().accountActivity}
        head={<SecurityTabs active="activity" />}
        scrollKey="account-activity"
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              results={count()}
              onChange={(next) => {
                setState(next);
                // The bar wrote the address; the server reads the range from it and renders the entries.
                void swapPage(`${window.location.pathname}${window.location.search}`, { replace: true, scroll: "preserve" });
              }}
            />
            <StatusRow lead={count()} />
          </>
        }
      >
        <Table
          label={t().accountActivity}
          rows={props.rows}
          rowKey={(row) => row.id}
          empty={{ icon: "clipboard-list", text: t().noActivityInRange }}
          phone={(row) => ({ lines: [row.label, row.context ?? t().accountContext], time: row.time, marks: outcome(row) })}
          columns={[
            { title: t().time, width: { min: 150, default: 170 }, cell: (row) => row.time },
            { title: t().activity, width: { min: 180, default: 240 }, cell: (row) => row.label },
            { title: t().status, width: { min: 110, default: 120 }, cell: outcome },
            { title: t().context, cell: (row) => row.context ?? "–", drop: true },
          ]}
        />
      </Pane>
    </AccountWorkspace>
  );
}
