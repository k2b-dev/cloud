import { expect, test } from "bun:test";
import { z } from "zod";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { CloudResourceReaderViewSchema } from "../contracts/capabilities";
import { bindAppEvents } from "../events/app-events";
import { sql } from "../runtime/clients";
import { connections } from "../runtime/connections";
import { codeOwnerTitleChanged } from "./accounts";

databaseSuite()("Code owner title updates", () => {
  test("only the declared owner's title changes and rollback preserves the prior title", async () => {
    const appId = connections().appId;
    bindAppEvents(appId, {
      protocolVersion: 2,
      types: { item: { title: "Item", description: "Title fixture", reader: "item.read", access: { readable: () => [] } } },
      queries: {
        "item.read": {
          title: "Read item",
          description: "Read the title fixture.",
          input: z.object({ id: z.string().min(1).max(512).describe("Resource ID.") }).strict(),
          data: z.object({ view: CloudResourceReaderViewSchema }),
          openWorld: false,
          codeResourceTitle: () => "Item",
          run: async () => ({ ok: true as const, data: { data: { view: { title: "Item", permission: "read" as const } } } }),
        },
      },
      code: { owners: ["item"] },
    });
    const ref = { type: `${appId}.item`, id: "Title1" };
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind,handle,title)
      VALUES(${`code:${ref.type}:${ref.id}`},'code','code-7k2q9m4xwt','Old title') RETURNING id`;
    try {
      await sql.begin((tx) => codeOwnerTitleChanged(tx, ref, "New title"));
      expect((await sql`SELECT title,handle FROM auth.service_accounts WHERE id=${account!.id}::uuid`)[0]).toEqual({
        title: "New title",
        handle: "code-7k2q9m4xwt",
      });
      await expect(
        sql.begin(async (tx) => {
          await codeOwnerTitleChanged(tx, ref, "Rolled back");
          throw new Error("rollback fixture");
        }),
      ).rejects.toThrow("rollback fixture");
      expect((await sql`SELECT title FROM auth.service_accounts WHERE id=${account!.id}::uuid`)[0]?.title).toBe("New title");
      await expect(sql.begin((tx) => codeOwnerTitleChanged(tx, { ...ref, type: "foreign.item" }, "Denied"))).rejects.toThrow(
        "Code owner must belong",
      );
      await expect(sql.begin((tx) => codeOwnerTitleChanged(tx, { ...ref, type: `${appId}.undeclared` }, "Denied"))).rejects.toThrow(
        "Code owner must belong",
      );
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id=${account!.id}::uuid`;
    }
  });
});
