import { describe, expect, test } from "bun:test";
import { boardColumnOrderId, orderBoardColumns } from "./board-columns";
import type { SpaceColumn } from "./contracts";

const column = (id: string, rank: string): SpaceColumn => ({ id, spaceId: "Space1", name: id, color: null, rank, isDone: false });

describe("board column order", () => {
  test("statuses and automatic columns share one rank order, numerically", () => {
    const board = orderBoardColumns(
      [column("Col010", "10240"), column("Col001", "1024"), column("Col002", "2048")],
      [
        { kind: "overdue", rank: "4096" },
        { kind: "blocked", rank: "1536" },
      ],
    );
    expect(board.map(boardColumnOrderId)).toEqual(["Col001", "blocked", "Col002", "overdue", "Col010"]);
  });

  test("on a tied rank the status comes first", () => {
    const board = orderBoardColumns([column("Col001", "1024"), column("Col002", "2048")], [{ kind: "blocked", rank: "1024" }]);
    expect(board.map(boardColumnOrderId)).toEqual(["Col001", "blocked", "Col002"]);
  });
});
