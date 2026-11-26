import { Chip, Table } from "@k2b/ui/v2";
import type { AgentListEntry } from "./AgentsScreen";
import { useAgentMessages } from "./messages";

/** The agents as a table, an island: a press anywhere on a row opens the agent, not only on its name. */
export default function AgentsTable(props: { agents: readonly AgentListEntry[] }) {
  const t = useAgentMessages();
  return (
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
  );
}
