import { expect, test } from "bun:test";
import type { Node } from "@k2b/filegate";
import { fileEntry } from "./file-entry";

const baseId = "cloud:users:6f1c2e4a-1b2c-4d3e-8f90-1234567890ab";
const fileId = "019b72cf-5200-7000-8000-000000000001";
const node = (id?: string): Node => ({
  root: "cloud",
  path: "users/alice/Docs/a.txt",
  ...(id ? { id } : {}),
  directory: false,
  size: 3,
  modified: "2026-10-05T12:00:00Z",
  mode: "0600",
  uid: 0,
  gid: 0,
  revision: "r1",
});

test("a stable ref is minted only on a stable-ID base for a node with an ID", () => {
  expect(fileEntry({ id: baseId, stableIds: true }, "Docs/a.txt", node(fileId))).toEqual({
    name: "a.txt",
    path: "Docs/a.txt",
    directory: false,
    size: 3,
    modified: "2026-10-05T12:00:00Z",
    revision: "r1",
    resourceId: `n:${baseId}:${fileId}`,
  });
  // Per entry, not per base: a node Filegate has not identified keeps a path ref.
  expect(fileEntry({ id: baseId, stableIds: true }, "Docs/a.txt", node())).not.toHaveProperty("resourceId");
  // An ID without the root capability carries no stability promise (a 6.1 daemon on an indexed, unmanaged root).
  expect(fileEntry({ id: baseId, stableIds: false }, "Docs/a.txt", node(fileId))).not.toHaveProperty("resourceId");
  expect(fileEntry({ id: baseId }, "Docs/a.txt", node(fileId))).not.toHaveProperty("resourceId");
});
