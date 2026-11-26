import { LocaleProvider } from "@k2b/ui";
import { Bar, Pane, RecordHead, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { render } from "solid-js/web";
import AccountsNav from "../AccountsNav";
import NewUserScreen from "../users/new/NewUserScreen";
import ApiKeysSection from "./ApiKeysSection";
import { KEYS_PER_PAGE, type KeyPage, toKeyPage } from "./account-keys";
import { toAccountKey } from "./api-key-row";
import DirectoryAccessSection from "./DirectoryAccessSection";
import {
  accountRequest,
  agentAccount,
  agentKeys,
  directoryPage,
  HUGE_TOTAL,
  hugeSources,
  policy,
  RESOURCE_ID,
  RESOURCE_TOTAL,
  resourceSources,
  worstKeys,
} from "./keys-and-new-user.fixture";

/**
 * The screens of lane C for a browser test; `<html data-state>` names the screen and its state, the test answers the
 * API. "record" stands in for an account's record (lane E's frame) with the two sections in it.
 */
type State =
  | {
      screen: "record";
      keys?: "sample" | "worst" | "huge" | "empty" | "failed";
      active?: boolean;
      open?: string;
      owner?: "agent" | "resource";
      app?: boolean;
    }
  | { screen: "new-user"; request?: boolean; emailOptional?: boolean };

document.documentElement.dataset.start = String(performance.now());
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = JSON.parse(document.documentElement.dataset.state ?? "{}") as State;

const context = { locale: "de", timeZone: "Europe/Berlin", now: new Date("2026-11-25T12:00:00Z") };

/**
 * The first page as the record's server reads it, with the key `?key=` names looked up by its id (`firstKeyPage`):
 * found among all of the owner's keys, else null.
 */
const serverPage = (sources: (page: number, perPage: number) => ReturnType<typeof hugeSources>, total: number, open?: string): KeyPage => {
  const page = toKeyPage({ items: sources(1, KEYS_PER_PAGE), total }, 1, context);
  if (!open || open === "new") return page;
  const found = Array.from({ length: Math.ceil(total / KEYS_PER_PAGE) }, (_, index) => sources(index + 1, KEYS_PER_PAGE))
    .flat()
    .find((source) => source.id === open);
  return { ...page, open: found ? toAccountKey(found, context) : null };
};

const record = (props: Extract<State, { screen: "record" }>) => {
  const keys = props.keys === "worst" ? worstKeys : props.keys === "empty" ? [] : props.keys === "sample" || !props.keys ? agentKeys : null;
  const first =
    props.owner === "resource"
      ? serverPage(resourceSources, RESOURCE_TOTAL, props.open)
      : props.keys === "huge"
        ? serverPage(hugeSources, HUGE_TOTAL, props.open)
        : keys
          ? { keys, total: keys.length, page: 1 }
          : null;
  const account =
    props.owner === "resource"
      ? {
          kind: "resource" as const,
          id: RESOURCE_ID,
          name: "Postfach Einkauf",
          active: true,
          // an app's own account: its rotating keys are managed in the app's administration
          ...(props.app ? { managedAt: "/admin/apps?app=mail&view=keys" } : {}),
        }
      : { ...agentAccount, active: props.active !== false };
  return (
    <Workspace
      sidebar={<AccountsNav active="users" pendingRequests={1} />}
      head={
        <Bar
          start={
            <RecordHead name={account.name} avatar={{ name: account.name }} kinds={[props.owner === "resource" ? "API Key" : "Agent"]} />
          }
        />
      }
    >
      <Pane label={account.name} scrollKey="harness-record">
        <ApiKeysSection account={account} first={first} modelsAvailable timeZone="Europe/Berlin" open={props.open} />
        <Show when={props.owner !== "resource"}>
          <DirectoryAccessSection account={agentAccount} initial={directoryPage} />
        </Show>
      </Pane>
    </Workspace>
  );
};

render(
  () => (
    <LocaleProvider locale="de">
      {state.screen === "record" ? (
        record(state)
      ) : (
        <NewUserScreen
          categoryPolicy={policy}
          freeIpaEnabled
          localEmailOptional={state.emailOptional === true}
          request={state.request ? accountRequest : null}
          pendingRequests={1}
        />
      )}
    </LocaleProvider>
  ),
  host,
);
