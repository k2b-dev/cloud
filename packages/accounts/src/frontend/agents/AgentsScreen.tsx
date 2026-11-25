import { Bar, Button, Chip, Pane, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";
import AccountsNav from "../AccountsNav";
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

/** The agents of this Cloud on v2: one row per agent opens its page. Dates come formatted from the server. */
export default function AgentsScreen(props: Props) {
  const t = useAgentMessages();
  return (
    <Workspace
      sidebar={<AccountsNav active="agents" pendingRequests={props.pendingRequests} />}
      head={<Bar start={<Text type="body">{t().agents}</Text>} />}
    >
      <Pane label={t().agents} scrollKey="accounts-agents" status={<StatusRow lead={t().agentsCount({ count: props.total })} />}>
        <Table
          label={t().agents}
          rows={props.agents}
          rowKey={(agent) => agent.id}
          open={(agent) => ({ href: `/app/accounts/agents/${agent.id}` })}
          empty={{ icon: "robot", text: t().noAgents }}
          phone={(agent) => ({
            lines: [agent.name, `${agent.active ? t().active : t().disabled} · ${t().createdOn({ when: agent.created })}`],
          })}
          columns={[
            { title: t().name, width: { min: 200, default: 320 }, cell: (agent) => agent.name },
            {
              title: t().status,
              width: { min: 120, default: 140 },
              cell: (agent) => <Chip status={agent.active ? "ok" : "bad"}>{agent.active ? t().active : t().disabled}</Chip>,
            },
            { title: t().created, cell: (agent) => agent.created, drop: true },
          ]}
        />
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
