import { afterAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { ItemFilterSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { listFiltered, move } from "./items";

const suite = databaseSuite();

suite("Spaces item moves", () => {
  const createdSpaces: string[] = [];
  afterAll(async () => {
    for (const id of createdSpaces) await sql`DELETE FROM spaces.spaces WHERE id = ${id}::uuid`;
  });

  /** Creates a Space whose columns hold `[title, rank]` items; returns internal IDs by name and title. */
  const createBoard = async (columns: Record<string, [title: string, rank: number][]>) => {
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces.spaces (short_id, name) VALUES (${newShortId()}, 'Item move test') RETURNING id
    `;
    const spaceId = space!.id;
    createdSpaces.push(spaceId);
    const column: Record<string, string> = {};
    const item: Record<string, string> = {};
    for (const [index, [name, items]] of Object.entries(columns).entries()) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, rank, is_done)
        VALUES (${newShortId()}, ${spaceId}::uuid, ${name}, ${(index + 1) * 1024}, false)
        RETURNING id
      `;
      column[name] = row!.id;
      for (const [title, rank] of items) {
        const [created] = await sql<{ id: string }[]>`
          INSERT INTO spaces.items (short_id, space_id, column_id, title, rank)
          VALUES (${newShortId()}, ${spaceId}::uuid, ${row!.id}::uuid, ${title}, ${rank})
          RETURNING id
        `;
        item[title] = created!.id;
      }
    }
    return { spaceId, column, item };
  };

  /** Titles and ranks of one column in list order, the order every view and page uses. */
  const columnState = async (columnId: string) => {
    const rows = await sql<{ title: string; rank: string }[]>`
      SELECT item.title, item.rank::text AS rank FROM spaces.items AS item
      WHERE item.column_id = ${columnId}::uuid
      ORDER BY item.rank, item.id
    `;
    return { titles: rows.map((row) => row.title), ranks: rows.map((row) => BigInt(row.rank)) };
  };

  const strictlyIncreasing = (ranks: bigint[]) => ranks.every((value, index) => index === 0 || value > ranks[index - 1]!);

  /**
   * Moves an item to another column in an open transaction on its own connection, the way a column
   * change outside `move` does (item PATCH, wormhole transfer), and holds the row lock until `commit`.
   */
  const holdColumnChange = async (itemId: string, columnId: string, targetRank: number) => {
    const writer = await sql.reserve();
    await writer`BEGIN`;
    const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
    await writer`UPDATE spaces.items SET column_id = ${columnId}::uuid, rank = ${targetRank} WHERE id = ${itemId}::uuid`;
    const waitForWaiter = async () => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const [row] = await sql<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${backend!.pid}::int = ANY(pg_blocking_pids(pid))) AS waiting
        `;
        if (row?.waiting) return true;
        await Bun.sleep(10);
      }
      return false;
    };
    let open = true;
    const finish = async (statement: "COMMIT" | "ROLLBACK") => {
      if (!open) return;
      open = false;
      try {
        await (statement === "COMMIT" ? writer`COMMIT` : writer`ROLLBACK`);
      } finally {
        writer.release();
      }
    };
    return { waitForWaiter, commit: () => finish("COMMIT"), rollback: () => finish("ROLLBACK") };
  };

  test("keeps a card dropped below the last loaded card of a paged column ahead of the unloaded cards", async () => {
    const titles = Array.from({ length: 40 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`);
    const { spaceId, column, item } = await createBoard({
      Open: titles.map((title, index) => [title, (index + 1) * 1024]),
      Review: [["X", 1024]],
    });
    const page = async (number: number) =>
      (
        await listFiltered({
          spaceId,
          filter: {
            ...ItemFilterSchema.parse({ sort: "column", groupBy: "column", page: number, pageSize: 30 }),
            columnIds: [column.Open!],
          },
        })
      ).items.map((entry) => entry.title);

    // The board loaded T01..T30; T31 has the rank a client would have computed for "after T30".
    expect(await move({ id: item.X!, columnId: column.Open!, afterItemId: item.T30! })).toMatchObject({ ok: true });
    expect(await page(1)).toEqual(titles.slice(0, 30));
    expect((await page(2)).slice(0, 2)).toEqual(["X", "T31"]);

    // Within the same column the moved card leaves its old slot and lands after the anchor.
    expect(await move({ id: item.T05!, columnId: column.Open!, afterItemId: item.T30! })).toMatchObject({ ok: true });
    expect(await page(1)).toEqual([...titles.slice(0, 4), ...titles.slice(5, 30), "T05"]);
    expect((await page(2)).slice(0, 2)).toEqual(["X", "T31"]);
    // Placement found room between the neighbors, so no other card was renumbered.
    const state = await columnState(column.Open!);
    expect(state.ranks.slice(-10)).toEqual(titles.slice(30).map((_, index) => BigInt((index + 31) * 1024)));
    expect(strictlyIncreasing(state.ranks)).toBe(true);
  });

  test("places a card at the top with beforeItemId or without a position and keeps an explicit rank as given", async () => {
    const { column, item } = await createBoard({
      Open: [
        ["A", 1024],
        ["B", 2048],
      ],
      Review: [
        ["X", 1024],
        ["Y", 2048],
        ["Z", 3072],
      ],
    });
    expect(await move({ id: item.X!, columnId: column.Open!, beforeItemId: item.A! })).toMatchObject({ ok: true });
    expect((await columnState(column.Open!)).titles).toEqual(["X", "A", "B"]);
    expect(await move({ id: item.Y!, columnId: column.Open! })).toMatchObject({ ok: true });
    expect((await columnState(column.Open!)).titles).toEqual(["Y", "X", "A", "B"]);

    // Existing clients that compute the rank themselves keep working unchanged.
    expect(await move({ id: item.Z!, columnId: column.Open!, rank: "1500" })).toMatchObject({ ok: true, data: { rank: "1500" } });
    expect((await columnState(column.Open!)).titles).toEqual(["Y", "X", "A", "Z", "B"]);
    // An anchor wins over a rank sent alongside it.
    expect(await move({ id: item.Z!, columnId: column.Open!, afterItemId: item.Y!, rank: "999999" })).toMatchObject({ ok: true });
    expect((await columnState(column.Open!)).titles).toEqual(["Y", "Z", "X", "A", "B"]);
  });

  test("renumbers the column when neighbors tie or their gap is exhausted", async () => {
    const { column, item } = await createBoard({
      Tied: [
        ["P", 2048],
        ["Q", 2048],
        ["R", 2048],
      ],
      Tight: [
        ["A", 1024],
        ["B", 1025],
      ],
      Halving: [
        ["C", 1024],
        ["D", 2048],
      ],
      Source: [
        ["X", 1024],
        ["Y", 2048],
        ...Array.from({ length: 12 }, (_, index): [string, number] => [`M${index + 1}`, (index + 3) * 1024]),
      ],
    });

    // Ties sort by ID; "after the first" must land before the second, which no rank between equal ranks can express.
    const [first, second, third] = (await columnState(column.Tied!)).titles;
    expect(await move({ id: item.X!, columnId: column.Tied!, afterItemId: item[first!]! })).toMatchObject({ ok: true });
    const afterTie = await columnState(column.Tied!);
    expect(afterTie.titles).toEqual([first!, "X", second!, third!]);
    expect(afterTie.ranks).toEqual([1024n, 2048n, 3072n, 4096n]);

    expect(await move({ id: item.Y!, columnId: column.Tight!, afterItemId: item.A! })).toMatchObject({ ok: true });
    const afterTight = await columnState(column.Tight!);
    expect(afterTight.titles).toEqual(["A", "Y", "B"]);
    expect(strictlyIncreasing(afterTight.ranks)).toBe(true);

    // Each drop directly below C halves the gap; the eleventh finds none left and renumbers.
    for (let index = 1; index <= 12; index++) {
      expect(await move({ id: item[`M${index}`]!, columnId: column.Halving!, afterItemId: item.C! })).toMatchObject({ ok: true });
    }
    const halved = await columnState(column.Halving!);
    expect(halved.titles).toEqual(["C", ...Array.from({ length: 12 }, (_, index) => `M${12 - index}`), "D"]);
    expect(strictlyIncreasing(halved.ranks)).toBe(true);
  });

  test("rejects a position that is not in the target column and changes nothing", async () => {
    const { column, item } = await createBoard({
      Open: [
        ["A", 1024],
        ["B", 2048],
      ],
      Review: [["X", 1024]],
    });
    expect(await move({ id: item.X!, columnId: column.Open!, afterItemId: item.X! })).toMatchObject({ ok: false, status: 400 });
    expect(await move({ id: item.A!, columnId: column.Open!, afterItemId: item.B!, beforeItemId: item.B! })).toMatchObject({
      ok: false,
      status: 400,
    });
    // An anchor outside the target column means the client's picture is stale.
    expect(await move({ id: item.A!, columnId: column.Review!, afterItemId: item.B! })).toMatchObject({ ok: false, status: 409 });
    // The route answers 404 for an unknown neighbor; one deleted after that check is no longer in the column here.
    expect(await move({ id: item.A!, columnId: column.Review!, afterItemId: crypto.randomUUID() })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect((await columnState(column.Open!)).titles).toEqual(["A", "B"]);
    expect((await columnState(column.Review!)).titles).toEqual(["X"]);
  });

  test("leaves an item that a concurrent writer moves out of the column alone while renumbering", async () => {
    const { column, item } = await createBoard({
      Open: [
        ["P", 1024],
        ["Q", 1025],
        ["Z", 5000],
      ],
      Review: [["B1", 1024]],
      Source: [["X", 1024]],
    });
    // Z goes to the top of Review; the renumbering move below still read Z in Open and waits for its row lock.
    const writer = await holdColumnChange(item.Z!, column.Review!, 0);
    try {
      const moved = move({ id: item.X!, columnId: column.Open!, afterItemId: item.P! });
      expect(await writer.waitForWaiter()).toBe(true);
      await writer.commit();
      expect(await moved).toMatchObject({ ok: true });
    } finally {
      await writer.rollback();
    }
    expect(await columnState(column.Review!)).toEqual({ titles: ["Z", "B1"], ranks: [0n, 1024n] });
    const open = await columnState(column.Open!);
    expect(open.titles).toEqual(["P", "X", "Q"]);
    expect(strictlyIncreasing(open.ranks)).toBe(true);
  });

  test("rejects a renumbering move whose previous neighbor leaves the column meanwhile and changes nothing", async () => {
    const { column, item } = await createBoard({
      Open: [
        ["P", 1024],
        ["Q", 1025],
      ],
      Review: [["B1", 1024]],
      Source: [["X", 1024]],
    });
    const writer = await holdColumnChange(item.P!, column.Review!, 0);
    try {
      const moved = move({ id: item.X!, columnId: column.Open!, afterItemId: item.P! });
      expect(await writer.waitForWaiter()).toBe(true);
      await writer.commit();
      expect(await moved).toMatchObject({ ok: false, status: 409 });
    } finally {
      await writer.rollback();
    }
    expect(await columnState(column.Open!)).toEqual({ titles: ["Q"], ranks: [1025n] });
    expect(await columnState(column.Review!)).toEqual({ titles: ["P", "B1"], ranks: [0n, 1024n] });
    expect((await columnState(column.Source!)).titles).toEqual(["X"]);
  });

  test("serializes concurrent moves into one exhausted gap without ties", async () => {
    const movers = Array.from({ length: 8 }, (_, index) => `M${index + 1}`);
    const { column, item } = await createBoard({
      Open: [
        ["A", 1024],
        ["B", 1025],
      ],
      Review: movers.map((title, index) => [title, (index + 1) * 1024]),
    });
    const results = await Promise.all(
      movers.map((title, index) =>
        move({ id: item[title]!, columnId: column.Open!, ...(index % 2 === 0 ? { afterItemId: item.A! } : { beforeItemId: item.B! }) }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const state = await columnState(column.Open!);
    expect(state.titles[0]).toBe("A");
    expect(state.titles.at(-1)).toBe("B");
    expect(state.titles.slice(1, -1).toSorted()).toEqual(movers.toSorted());
    expect(strictlyIncreasing(state.ranks)).toBe(true);
    expect((await columnState(column.Review!)).titles).toEqual([]);
  });
});
