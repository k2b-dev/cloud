import { LocaleProvider } from "@k2b/ui";
import { Bar, Pane, RecordHead, Workspace } from "@k2b/ui/v2";
import { render } from "solid-js/web";
import AccountsNav from "../AccountsNav";
import NewUserScreen from "../users/new/NewUserScreen";
import ApiKeysSection from "./ApiKeysSection";
import { KEYS_PER_PAGE, toKeyPage } from "./account-keys";
import DirectoryAccessSection from "./DirectoryAccessSection";
import {
  accountRequest,
  agentAccount,
  agentKeys,
  directoryPage,
  HUGE_TOTAL,
  hugeSources,
  policy,
  worstKeys,
} from "./keys-and-new-user.fixture";

/**
 * The screens of lane C for a browser test; `<html data-state>` names the screen and its state, the test answers the
 * API. "record" stands in for an account's record (lane E's frame) with the two sections in it.
 */
type State =
  | { screen: "record"; keys?: "sample" | "worst" | "huge" | "empty" | "failed"; active?: boolean; open?: string }
  | { screen: "new-user"; request?: boolean; emailOptional?: boolean };

document.documentElement.dataset.start = String(performance.now());
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = JSON.parse(document.documentElement.dataset.state ?? "{}") as State;

const record = (props: Extract<State, { screen: "record" }>) => {
  const keys = props.keys === "worst" ? worstKeys : props.keys === "empty" ? [] : props.keys === "sample" || !props.keys ? agentKeys : null;
  const first =
    props.keys === "huge"
      ? toKeyPage({ items: hugeSources(1, KEYS_PER_PAGE), total: HUGE_TOTAL }, 1, {
          locale: "de",
          timeZone: "Europe/Berlin",
          now: new Date("2026-11-25T12:00:00Z"),
        })
      : keys
        ? { keys, total: keys.length, page: 1 }
        : null;
  const account = { ...agentAccount, active: props.active !== false };
  return (
    <Workspace
      sidebar={<AccountsNav active="users" pendingRequests={1} />}
      head={<Bar start={<RecordHead name={account.name} avatar={{ name: account.name }} kinds={["Agent"]} />} />}
    >
      <Pane label={account.name} scrollKey="harness-record">
        <ApiKeysSection account={account} first={first} modelsAvailable timeZone="Europe/Berlin" open={props.open} />
        <DirectoryAccessSection account={account} initial={directoryPage} />
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
