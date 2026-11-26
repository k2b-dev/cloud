import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import GroupsScreen from "../GroupsScreen";
import NewGroupDialog from "../NewGroupDialog";
import { groupsQuery, parseGroupsAddress } from "../query";
import GroupScreen, { type GroupScreenProps } from "./GroupScreen";
import { groupList } from "./group-screens.fixture";

/**
 * A group's page for a browser test: `<html data-state>` carries the language and the props the server would pass, or
 * the dialog for a new group alone; when the dialog closes, `<body data-closed>` says how.
 */
type State =
  | { screen: "group"; locale: string; props: GroupScreenProps }
  | { screen: "new-group"; locale: string; freeIpaEnabled: boolean; linuxEnabled: boolean }
  | { screen: "groups"; locale: string };

// when the screen starts to render, so a test can time the screen apart from loading the test page
document.documentElement.dataset.renderStart = String(performance.now());
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = JSON.parse(document.documentElement.dataset.state ?? "{}") as State;
render(
  () => (
    <LocaleProvider locale={state.locale}>
      {state.screen === "group" ? (
        <GroupScreen {...state.props} />
      ) : state.screen === "groups" ? (
        <GroupsScreen
          state={parseGroupsAddress(groupsQuery(state.locale, "all"), new URLSearchParams("scope=all")).state}
          defaultScope="all"
          page={1}
          pages={1}
          total={groupList.length}
          groups={groupList}
          isAdmin
          freeIpaEnabled
          linuxEnabled
          pendingRequests={2}
          ignored={null}
        />
      ) : (
        <NewGroupDialog
          open
          freeIpaEnabled={state.freeIpaEnabled}
          linuxEnabled={state.linuxEnabled}
          close={(result) => {
            document.body.dataset.closed = result ? "created" : "cancelled";
          }}
        />
      )}
    </LocaleProvider>
  ),
  host,
);
