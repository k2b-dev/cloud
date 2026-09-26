import { createSignal } from "solid-js";
import { workspaceRevisionHeader } from "../../../contracts";

// Page-owned status shared by independently hydrated workspace/dialog islands.
export const [workspaceLiveStatus, setWorkspaceLiveStatus] = createSignal<{ revoked: boolean; message: string }>({
  revoked: false,
  message: "",
});

export const workspaceResourceAppliedEvent = "grids:workspace-resource-applied";

/** Structure revisions the server reports for a write of this tab: `key=revision[,key=revision]`. */
export const parseWorkspaceRevisionHeader = (value: string | null): Array<{ key: string; revision: string }> =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim().split("="))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== "" && parts[1] !== "")
    .map(([key, revision]) => ({ key, revision }));

export const workspaceFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const state = workspaceLiveStatus();
  if (state.revoked) throw new Error(state.message);
  const response = await fetch(input, init);
  for (const detail of parseWorkspaceRevisionHeader(response.headers.get(workspaceRevisionHeader))) {
    document.dispatchEvent(new CustomEvent(workspaceResourceAppliedEvent, { detail }));
  }
  return response;
};
