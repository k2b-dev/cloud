import { Bar, Button, Pane, StatusRow, Text, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";
import AccountsNav from "../AccountsNav.island";
import AgentsTable from "./AgentsTable.island";
import { useAgentMessages } from "./messages";

export type AgentListEntry = { id: string; name: string; active: boolean; created: string };

type Props = {
  agents: readonly AgentListEntry[];
  total: number;
  page: number;
  pages: number;
  pendingRequests: number;
};

const pageHref = (page: number) => (page > 1 ? `/app/accounts/agents?page=${page}` : "/app/accounts/agents");

/**
 * The agents of this Cloud on v2: one row per agent opens its page. Dates come formatted from the server. The page
 * renders the frame, its head, status and pager on the server; only the sidebar (its search) and the table are islands.
 */
export default function AgentsScreen(props: Props) {
  const t = useAgentMessages();
  return (
    <Workspace
      sidebar={<AccountsNav active="agents" pendingRequests={props.pendingRequests} />}
      head={<Bar start={<Text type="body">{t().agents}</Text>} />}
    >
      <Pane label={t().agents} scrollKey="accounts-agents" status={<StatusRow lead={t().agentsCount({ count: props.total })} />}>
        <AgentsTable agents={props.agents} />
        <Show when={props.pages > 1}>
          <Bar
            start={<Text type="meta">{t().pageOf({ page: props.page, pages: props.pages })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={pageHref(props.page - 1)} disabled={props.page <= 1}>
                  {t().previous}
                </Button>
                <Button href={pageHref(props.page + 1)} disabled={props.page >= props.pages} forward>
                  {t().next}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
    </Workspace>
  );
}
