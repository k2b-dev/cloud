import { render } from "solid-js/web";
import type { RequestStatusView } from "../requests/requests-url";
import { OverviewFixture, RequestsFixture } from "./overview-requests.fixture";

/**
 * The overview and the request list for a browser test: the path names the screen, `<html data-state>` its state.
 * The test stands in for the server and answers the API.
 */
type State = { admin?: boolean; worst?: boolean; empty?: boolean; freeIpa?: boolean };

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const state = JSON.parse(document.documentElement.dataset.state ?? "{}") as State;
const status = (new URLSearchParams(location.search).get("status") ?? "pending") as RequestStatusView;
render(
  () =>
    location.pathname.endsWith("/requests") ? (
      <RequestsFixture status={status} worst={state.worst} empty={state.empty} freeIpa={state.freeIpa} />
    ) : (
      <OverviewFixture admin={state.admin} worst={state.worst} empty={state.empty} />
    ),
  host,
);
