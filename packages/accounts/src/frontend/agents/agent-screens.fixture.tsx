import { LocaleProvider } from "@k2b/ui";
import type { AgentKeyView } from "./AgentKeyDialogs";
import AgentScreen, { type AgentView } from "./AgentScreen";
import AgentsScreen, { type AgentListEntry } from "./AgentsScreen";
import type { AgentKeyOpen, AgentKeySort } from "./agent-keys";

// Frozen sample data for the agent screens: dates are formatted text as the server sends them, ids are fixed.

export const AGENT_ID = "0b2f5c7e-0000-4000-8000-0000000000bb";
export const KEY_IDS = [
  "4d1e8a20-0000-4000-8000-000000000001",
  "4d1e8a20-0000-4000-8000-000000000002",
  "4d1e8a20-0000-4000-8000-000000000003",
];

export const agent: AgentView = {
  id: AGENT_ID,
  name: "Wochenbericht",
  active: true,
  avatarHash: null,
  created: "22.09.2026, 09:14",
  createdBy: { name: "Jana Berger", href: "/app/accounts/users/7a3c0000-0000-4000-8000-000000000001" },
};

export const keys: AgentKeyView[] = [
  {
    id: KEY_IDS[0]!,
    name: "Laptop Jana",
    tokenPrefix: "k2b_sa_7f3a",
    access: "full",
    created: "22.09.2026, 09:20",
    lastUsed: "24.11.2026, 18:02",
    expires: null,
    expired: false,
  },
  {
    id: KEY_IDS[1]!,
    name: "MCP-Server Team Ops",
    tokenPrefix: "k2b_sa_91c0",
    access: "models",
    created: "03.11.2026, 14:41",
    lastUsed: null,
    expires: "31.12.2026, 23:59",
    expired: false,
  },
  {
    id: KEY_IDS[2]!,
    name: "Alter Export-Job",
    tokenPrefix: "k2b_sa_0b52",
    access: "legacy",
    created: "02.03.2026, 08:00",
    lastUsed: "30.06.2026, 07:15",
    expires: "01.07.2026, 00:00",
    expired: true,
  },
];

export const agents: AgentListEntry[] = [
  { id: AGENT_ID, name: "Wochenbericht", active: true, created: "22.09.2026, 09:14" },
  { id: "0b2f5c7e-0000-4000-8000-0000000000bc", name: "Festplaner", active: true, created: "14.10.2026, 11:02" },
  { id: "0b2f5c7e-0000-4000-8000-0000000000bd", name: "Import Buchhaltung", active: false, created: "01.04.2026, 16:30" },
];

export const AgentScreenFixture = (props: { keys?: AgentKeyView[] | null; open?: AgentKeyOpen; sort?: AgentKeySort; active?: boolean }) => (
  <LocaleProvider locale="de">
    <AgentScreen
      agent={{ ...agent, active: props.active ?? true }}
      keys={props.keys === undefined ? keys : props.keys}
      sort={props.sort ?? "created"}
      open={props.open ?? { kind: "none" }}
      modelsAvailable
      pendingRequests={2}
    />
  </LocaleProvider>
);

export const AgentsScreenFixture = (props: { empty?: boolean }) => (
  <LocaleProvider locale="de">
    <AgentsScreen agents={props.empty ? [] : agents} total={props.empty ? 0 : agents.length} page={1} pages={1} pendingRequests={2} />
  </LocaleProvider>
);
