import { hc } from "hono/client";
import { workspaceFetch } from "../frontend/_components/workspace/workspace-live-state";
import type { ApiType } from ".";

// The public Cloud client has no transport hook. Keep this workspace-specific
// stale-write guard in Grids, using Hono's supported typed fetch adapter.
export const apiClient = hc<ApiType>("/api/grids", { fetch: workspaceFetch });
