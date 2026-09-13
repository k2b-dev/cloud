import { afterEach, expect, test } from "bun:test";
import { isWorkspaceRead, setWorkspaceLiveStatus, workspaceFetch } from "./workspace-live-state";

afterEach(() => setWorkspaceLiveStatus({ blocked: false, revoked: false, message: "" }));

test("stale structure stops writes, not canonical GQL reads", async () => {
  expect(isWorkspaceRead("POST", "/api/grids/gql/by-base/BASE01/execute")).toBe(true);
  expect(isWorkspaceRead("POST", "/api/grids/tables/TABLE1/query")).toBe(true);
  expect(isWorkspaceRead("POST", "/api/grids/gql/by-base/BASE01/views/VIEW01/execute")).toBe(true);
  expect(isWorkspaceRead("POST", "/api/grids/records/by-table/TABLE1")).toBe(false);
  setWorkspaceLiveStatus({ blocked: true, revoked: false, message: "reload first" });
  await expect(workspaceFetch("/api/grids/records/by-table/TABLE1", { method: "POST" })).rejects.toThrow("reload first");
  setWorkspaceLiveStatus({ blocked: true, revoked: true, message: "access lost" });
  await expect(workspaceFetch("/api/grids/records/by-table/TABLE1")).rejects.toThrow("access lost");
});
