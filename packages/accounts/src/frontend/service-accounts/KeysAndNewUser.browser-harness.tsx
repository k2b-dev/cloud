import { LocaleProvider } from "@k2b/ui";
import { Bar, Pane, RecordHead, Workspace } from "@k2b/ui/v2";
import { render } from "solid-js/web";
import AccountsNav from "../AccountsNav";
import NewUserScreen from "../users/new/NewUserScreen";
import ApiKeysScreen from "./ApiKeysScreen";
import ApiKeysSection from "./ApiKeysSection";
import DirectoryAccessSection from "./DirectoryAccessSection";
import {
  accountRequest,
  agentAccount,
  agentKeys,
  directoryPage,
  listRows,
  policy,
  worstKeys,
  worstListRows,
} from "./keys-and-new-user.fixture";
import { apiKeysQuery, parseApiKeysAddress } from "./query";

/**
 * The screens of lane C for a browser test; `<html data-state>` names the screen and its state, the test answers the
 * API. "record" stands in for an account's record (lane E's frame) with the two sections in it.
 */
type State =
  | { screen: "record"; keys?: "sample" | "worst" | "empty" | "failed"; active?: boolean }
  | { screen: "list"; rows?: "sample" | "worst" | "empty" }
  | { screen: "new-user"; request?: boolean; emailOptional?: boolean };

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = JSON.parse(document.documentElement.dataset.state ?? "{}") as State;

const record = (props: Extract<State, { screen: "record" }>) => {
  const keys = props.keys === "worst" ? worstKeys : props.keys === "empty" ? [] : props.keys === "failed" ? null : agentKeys;
  const account = { ...agentAccount, active: props.active !== false };
  return (
    <Workspace
      sidebar={<AccountsNav active="users" pendingRequests={1} />}
      head={<Bar start={<RecordHead name={account.name} avatar={{ name: account.name }} kinds={["Agent"]} />} />}
    >
      <Pane label={account.name} scrollKey="harness-record">
        <ApiKeysSection account={account} keys={keys} total={keys?.length ?? 0} modelsAvailable timeZone="Europe/Berlin" />
        <DirectoryAccessSection account={account} initial={directoryPage} />
      </Pane>
    </Workspace>
  );
};

const list = (props: Extract<State, { screen: "list" }>) => {
  const address = parseApiKeysAddress(apiKeysQuery("de"), new URLSearchParams(location.search));
  const rows = props.rows === "worst" ? worstListRows : props.rows === "empty" ? [] : listRows;
  return (
    <ApiKeysScreen
      state={address.state}
      page={1}
      pages={1}
      total={rows.length}
      rows={rows}
      hiddenAutomatic={address.state.filters.automatic === "1" ? null : 3}
      modelsAvailable
      timeZone="Europe/Berlin"
      pendingRequests={1}
      ignored={null}
    />
  );
};

render(
  () => (
    <LocaleProvider locale="de">
      {state.screen === "record" ? (
        record(state)
      ) : state.screen === "list" ? (
        list(state)
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
