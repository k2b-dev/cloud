import { afterEach, expect, spyOn, test } from "bun:test";
import { parseWorkspaceRevisionHeader, setWorkspaceLiveStatus, workspaceFetch } from "./workspace-live-state";

afterEach(() => setWorkspaceLiveStatus({ revoked: false, message: "" }));

test("parses the revisions a write reports and ignores malformed entries", () => {
  expect(parseWorkspaceRevisionHeader(null)).toEqual([]);
  expect(parseWorkspaceRevisionHeader("table:TABLE1=abc, view:VIEW01=def,broken,=x,y=")).toEqual([
    { key: "table:TABLE1", revision: "abc" },
    { key: "view:VIEW01", revision: "def" },
  ]);
});

test("writes keep flowing; only revoked access stops requests", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => Response.json({}), { preconnect: fetch.preconnect }),
  );
  try {
    expect((await workspaceFetch("/api/grids/records/by-table/TABLE1", { method: "POST" })).ok).toBe(true);
    setWorkspaceLiveStatus({ revoked: true, message: "access lost" });
    await expect(workspaceFetch("/api/grids/records/by-table/TABLE1")).rejects.toThrow("access lost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    fetchMock.mockRestore();
  }
});
