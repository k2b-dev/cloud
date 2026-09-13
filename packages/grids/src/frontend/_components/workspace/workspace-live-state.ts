import { createSignal } from "solid-js";

// Page-owned status shared by independently hydrated workspace/dialog islands.
export const [workspaceLiveStatus, setWorkspaceLiveStatus] = createSignal<{
  blocked: boolean;
  revoked: boolean;
  message: string;
}>({ blocked: false, revoked: false, message: "" });

/** Call only after the complete resource response is reflected in the editor. */
export const acknowledgeWorkspaceResource = (baseId: string, key: string, revision: string | null) => {
  if (revision) document.dispatchEvent(new CustomEvent("grids:workspace-resource-applied", { detail: { baseId, key, revision } }));
};

// GQL's POST endpoints only read/compile; stale schema must not stop reconciliation.
export const isWorkspaceRead = (method: string, pathname: string) =>
  ["GET", "HEAD", "OPTIONS"].includes(method) ||
  (method === "POST" &&
    (/^\/api\/grids\/gql\/by-base\/[^/]+\/(preview|execute|autocomplete|compile-view|views\/[^/]+\/execute)$/.test(pathname) ||
      /^\/api\/grids\/tables\/[^/]+\/query$/.test(pathname)));

export const workspaceFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const state = workspaceLiveStatus();
  const pathname = new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname;
  if (state.revoked || (state.blocked && !isWorkspaceRead(method, pathname))) return Promise.reject(new Error(state.message));
  return fetch(input, init);
};
