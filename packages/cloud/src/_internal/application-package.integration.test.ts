import { expect, test } from "bun:test";
import { SQL } from "bun";
import { requireDatabaseUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { registerApplicationPackage } from "./application-package";

suiteFor("database")("durable application package registration", () => {
  test("shares a package and rejects app-ID collisions in either startup order, including concurrent claims", async () => {
    const db = new SQL(requireDatabaseUrl());
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const orders = `orders-${suffix}`;
    const stock = `stock-${suffix}`;
    const other = `other-${suffix}`;
    const owner = `owner-${suffix}`;
    const first = `first-${suffix}`;
    const racer = `racer-${suffix}`;
    const ids = [orders, stock, other, owner, first, racer];
    const group = `warenfluss-${suffix}`;
    try {
      await registerApplicationPackage(orders, group, db);
      await registerApplicationPackage(stock, group, db);
      await registerApplicationPackage(orders, group, db);
      // Persistent reservation, with no live registry entry at all.
      await expect(registerApplicationPackage(other, orders, db)).rejects.toThrow("reserved");
      await expect(registerApplicationPackage(orders, other, db)).rejects.toThrow("reserved");
      // Claiming the group name as a new app ID must also fail.
      await expect(registerApplicationPackage(group, undefined, db)).rejects.toThrow("reserved");
      await registerApplicationPackage(owner, undefined, db);
      await expect(registerApplicationPackage(other, owner, db)).rejects.toThrow("reserved");
      const attempts = await Promise.allSettled([
        registerApplicationPackage(first, racer, db),
        registerApplicationPackage(racer, undefined, db),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally {
      for (const id of ids) await db`DELETE FROM platform.application_packages WHERE app_id = ${id}`;
      await db.close();
    }
  });
});
