import { expect, test } from "bun:test";
import type { CurrentSide } from "./history-actions";
import { resolveTarget } from "./history-api";

const side: CurrentSide = {
  visibility: "full",
  source: "current",
  publicBaseId: "cloud:groups:team",
  baseId: "binding",
  root: "cloud",
  path: "groups/team/Archive/report.txt",
  relativePath: "Archive/report.txt",
  name: "report.txt",
  directory: false,
  itemId: null,
  size: null,
  revision: null,
};

test("a current path-only destination resolves its authorized relative path again", async () => {
  const original = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      requests.push(new URL(input instanceof Request ? input.url : String(input), "https://files.test"));
      return Response.json({ base: { id: side.publicBaseId }, entry: { path: side.relativePath } });
    },
    { preconnect: original.preconnect },
  );
  try {
    await resolveTarget({ kind: "side", side }, "Cannot open");
    expect(requests).toHaveLength(1);
    expect(decodeURIComponent(requests[0]!.pathname)).toBe("/api/filesv2/bases/cloud:groups:team/entry");
    expect(requests[0]!.searchParams.get("path")).toBe("Archive/report.txt");
    await expect(resolveTarget({ kind: "side", side: { ...side, relativePath: null } }, "Cannot open")).rejects.toThrow("Cannot open");
    expect(requests).toHaveLength(1);
  } finally {
    globalThis.fetch = original;
  }
});

test("a destination's newly denied permission stays a visible failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ error: "Access changed", code: "forbidden" }, { status: 403 }), {
    preconnect: original.preconnect,
  });
  try {
    await expect(resolveTarget({ kind: "side", side }, "Cannot open")).rejects.toThrow("Access changed");
  } finally {
    globalThis.fetch = original;
  }
});
