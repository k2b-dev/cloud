import { expect, test } from "bun:test";
import { toHomeActivity } from "./base-activity-model";

test("the browser gets public table ids, a person's picture address, and nothing of a table it may not name", () => {
  const home = toHomeActivity(
    {
      total: 5,
      points: [0, 1, 4],
      tables: { "internal-orders": { total: 4, points: [0, 1, 3] }, "internal-hidden": { total: 1, points: null } },
      pendingFinalizations: 1,
      failedRuns24h: 2,
      recent: [
        {
          tableId: "internal-orders",
          recordShortId: "REC001",
          title: "Küchenfront Eiche",
          updatedAt: "2026-10-26T09:50:00.000Z",
          user: { id: "user-1", name: "Mira Solberg", avatarHash: "abc" },
        },
        { tableId: "internal-orders", recordShortId: "REC002", title: null, updatedAt: "2026-10-26T09:40:00.000Z", user: null },
        { tableId: "internal-hidden", recordShortId: "REC003", title: "x", updatedAt: "2026-10-26T09:30:00.000Z", user: null },
      ],
    },
    new Map([["internal-orders", "ORDERS"]]),
  );
  expect(Object.keys(home.tables)).toEqual(["ORDERS"]);
  expect(home.recent).toEqual([
    {
      tableId: "ORDERS",
      recordShortId: "REC001",
      title: "Küchenfront Eiche",
      updatedAt: "2026-10-26T09:50:00.000Z",
      person: { name: "Mira Solberg", image: "/api/accounts/users/user-1/avatar?rev=abc" },
    },
    { tableId: "ORDERS", recordShortId: "REC002", title: null, updatedAt: "2026-10-26T09:40:00.000Z", person: null },
  ]);
});
