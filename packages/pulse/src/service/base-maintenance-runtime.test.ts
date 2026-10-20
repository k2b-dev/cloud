import { expect, mock, spyOn, test } from "bun:test";
import { BaseOperationSuperseded, baseStore } from "../store/base-store";
import * as maintenance from "../store/maintenance";
import { runCheckpointScan, runUsageScan } from "./base-maintenance-runtime";

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] as const;
const input = {
  slot: Date.parse("2026-10-17T12:00:00Z"),
  after: null,
  checkpointId: "33333333-3333-4333-8333-333333333333",
  verifyOnly: false,
};
const nextBase = async ({ after }: Parameters<typeof runUsageScan>[0]) => {
  const id = ids.find((id) => after === null || id > after);
  return id ? { base_id: id } : undefined;
};

for (const kind of ["usage", "checkpoint"] as const)
  for (const superseded of [false, true])
    test(`${kind} advances one base per run after ${superseded ? "supersession" : "a store failure"}`, async () => {
      const visited: string[] = [];
      const warn = mock(() => {});
      const operation = spyOn(maintenance, kind === "usage" ? "measureBaseUsage" : "writeBaseCheckpoint").mockImplementation(
        async (baseId: string) => {
          visited.push(baseId);
          if (baseId === ids[0]) throw superseded ? new BaseOperationSuperseded() : new Error("Do not log this transport body");
        },
      );
      try {
        const run = kind === "usage" ? runUsageScan : runCheckpointScan;
        const first = await run(input, baseStore, { nextBase, warn });
        expect(visited).toEqual([ids[0]!]);
        expect(first).toEqual({ ...input, after: ids[0] });
        if (!first) throw new Error("MISSING_CURSOR");
        const second = await run(first, baseStore, { nextBase, warn });
        expect(visited).toEqual([...ids]);
        expect(second).toEqual({ ...input, after: ids[1] });
        if (!second) throw new Error("MISSING_CURSOR");
        expect(await run(second, baseStore, { nextBase, warn })).toBeNull();
        expect(visited).toEqual([...ids]);
        if (superseded) expect(warn).not.toHaveBeenCalled();
        else expect(warn).toHaveBeenCalledWith(`Pulse base ${kind} failed`, { baseId: ids[0], errorCode: "STORE_UNREACHABLE" });
      } finally {
        operation.mockRestore();
      }
    });

test("startup verify-only requests reader and grant restoration", async () => {
  const warn = mock(() => {});
  const verify = spyOn(maintenance, "verifyBaseCheckpoint").mockResolvedValue(true);
  const write = spyOn(maintenance, "writeBaseCheckpoint").mockResolvedValue(undefined);
  try {
    const start = { ...input, checkpointId: null, verifyOnly: true };
    expect(await runCheckpointScan(start, baseStore, { nextBase, warn })).toEqual({ ...start, after: ids[0] });
    expect(verify).toHaveBeenCalledWith(ids[0], baseStore, true);
    expect(write).not.toHaveBeenCalled();
  } finally {
    verify.mockRestore();
    write.mockRestore();
  }
});
