import { expect, test } from "bun:test";
import { snapshotCoverage } from "./snapshot-cutover-preflight";

const sequence = (cursor: string) => {
  if (!/^owned\.\d+$/.test(cursor)) throw new Error("Wrong topic");
  return Number(cursor.split(".")[1]);
};
test("cutover requires a covering snapshot even after the entire log expired", () => {
  expect(snapshotCoverage({ cursor: "owned.8", hasSnapshot: true }, 8, sequence)).toBe("covered");
  expect(snapshotCoverage({ cursor: "owned.7", hasSnapshot: true }, 8, sequence)).toBe("snapshot_required");
  expect(snapshotCoverage({ cursor: "owned.9", hasSnapshot: true }, 8, sequence)).toBe("snapshot_required");
  expect(snapshotCoverage({ cursor: "owned.8", hasSnapshot: false }, 8, sequence)).toBe("snapshot_required");
  expect(snapshotCoverage({ cursor: "foreign.8", hasSnapshot: true }, 8, sequence)).toBe("invalid_cursor");
  expect(snapshotCoverage(null, 8, sequence)).toBe("deleted_note");
  expect(snapshotCoverage({ cursor: null, hasSnapshot: false }, 0, sequence)).toBe("covered");
});
