import { LocaleProvider } from "@k2b/ui";
import { KEYS_PER_PAGE, type KeyPage, toKeyPage } from "../service-accounts/account-keys";
import type { AccountKey } from "../service-accounts/api-key-row";
import { agentKeys, directoryPage, HUGE_TOTAL, hugeSources, worstKeys } from "../service-accounts/keys-and-new-user.fixture";
import AgentScreen, { type AgentView } from "./AgentScreen";
import AgentsScreen, { type AgentListEntry } from "./AgentsScreen";
import { AGENT_ID } from "./agent-screens.fixture-ids";

// Frozen sample data for the agent screens: dates are formatted text as the server sends them, ids are fixed.

export const agent: AgentView = {
  id: AGENT_ID,
  name: "Wochenbericht",
  active: true,
  image: `/api/accounts/users/${AGENT_ID}/avatar`,
  created: "22.09.2026, 09:14",
  createdBy: { name: "Jana Berger", href: "/app/accounts/users/7a3c0000-0000-4000-8000-000000000001" },
};

export const agents: AgentListEntry[] = [
  { id: AGENT_ID, name: "Wochenbericht", active: true, created: "22.09.2026, 09:14" },
  { id: "0b2f5c7e-0000-4000-8000-0000000000bc", name: "Festplaner", active: true, created: "14.10.2026, 11:02" },
  { id: "0b2f5c7e-0000-4000-8000-0000000000bd", name: "Import Buchhaltung", active: false, created: "01.04.2026, 16:30" },
];

/** The agent's keys and directory access as their sections' first pages, from the sections' own sample. */
const firstKeys = (keys: AccountKey[], total = keys.length): KeyPage => ({ keys, total, page: 1 });
export type KeysState = "sample" | "empty" | "failed" | "worst" | "huge";
const keyPage = (state: KeysState): KeyPage | null =>
  state === "failed"
    ? null
    : state === "empty"
      ? firstKeys([])
      : state === "worst"
        ? firstKeys(worstKeys)
        : state === "huge"
          ? toKeyPage({ items: hugeSources(1, KEYS_PER_PAGE), total: HUGE_TOTAL }, 1, {
              locale: "de",
              timeZone: "Europe/Berlin",
              now: new Date("2026-11-25T12:00:00.000Z"),
            })
          : firstKeys(agentKeys);

export const AgentScreenFixture = (props: { keys?: KeysState; active?: boolean }) => (
  <LocaleProvider locale="de">
    <AgentScreen
      agent={{ ...agent, active: props.active ?? true }}
      keys={keyPage(props.keys ?? "sample")}
      directory={directoryPage}
      modelsAvailable
      timeZone="Europe/Berlin"
      pendingRequests={2}
    />
  </LocaleProvider>
);

export const AgentsScreenFixture = (props: { empty?: boolean }) => (
  <LocaleProvider locale="de">
    <AgentsScreen agents={props.empty ? [] : agents} total={props.empty ? 0 : agents.length} page={1} pages={1} pendingRequests={2} />
  </LocaleProvider>
);
