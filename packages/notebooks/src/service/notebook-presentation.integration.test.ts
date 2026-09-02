import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { PRESENTATION_MODES } from "../lib/presentation-mode";
import { migrate } from "../migrate";
import * as notebooks from "./notebooks";
import * as workspaceEvents from "./workspace-events";

const postgresTest = process.env.NOTEBOOKS_DB_TEST === "1" ? test : test.skip;
const notebookId = crypto.randomUUID();
const accessId = crypto.randomUUID();
const shortId = Math.random().toString(36).slice(2, 8).padEnd(6, "x");
const name = `Presentation test ${shortId}`;
let published: ReturnType<typeof spyOn<typeof workspaceEvents, "notebookUpdated">> | undefined;

beforeAll(async () => {
  if (process.env.NOTEBOOKS_DB_TEST !== "1") return;
  await migrate();
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${notebookId}::uuid, ${shortId}, ${name})`;
  await sql`INSERT INTO auth.access (id, permission) VALUES (${accessId}::uuid, 'read')`;
  await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebookId}::uuid, ${accessId}::uuid)`;
  published = spyOn(workspaceEvents, "notebookUpdated").mockResolvedValue(undefined);
}, 30_000);

afterAll(async () => {
  published?.mockRestore();
  if (process.env.NOTEBOOKS_DB_TEST !== "1") return;
  await sql`DELETE FROM notebooks.notebooks WHERE id = ${notebookId}::uuid`;
  await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
}, 30_000);

describe("notebook default presentation persistence", () => {
  postgresTest("defaults notebooks to Write and exposes the mode on every notebook read", async () => {
    expect((await notebooks.get({ id: notebookId }))?.defaultPresentationMode).toBe("write");
    expect((await notebooks.getByShortId({ shortId }))?.defaultPresentationMode).toBe("write");
    expect((await notebooks.list({ userId: null, query: name })).items[0]?.defaultPresentationMode).toBe("write");
    expect(
      (await notebooks.listWithPermission({ userId: null, query: name, pagination: { limit: 1, offset: 0 } })).items[0]
        ?.defaultPresentationMode,
    ).toBe("write");
    expect((await notebooks.listAdmin({ search: name, pagination: { limit: 1, offset: 0 } })).items[0]?.defaultPresentationMode).toBe(
      "write",
    );
  });

  postgresTest("persists all supported defaults and preserves the choice on unrelated settings changes", async () => {
    for (const defaultPresentationMode of PRESENTATION_MODES) {
      const result = await notebooks.update({
        id: notebookId,
        data: { defaultPresentationMode },
        dateConfig: { locale: "en", timeZone: "UTC" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.data.defaultPresentationMode).toBe(defaultPresentationMode);
      expect(published).toHaveBeenLastCalledWith(expect.objectContaining({ id: notebookId, defaultPresentationMode }));
      await notebooks.update({ id: notebookId, data: { description: "Unrelated change" }, dateConfig: { locale: "en", timeZone: "UTC" } });
      expect((await notebooks.get({ id: notebookId }))?.defaultPresentationMode).toBe(defaultPresentationMode);
    }
  });

  postgresTest("the database rejects unknown presentation modes", async () => {
    const before = await notebooks.get({ id: notebookId });
    const update = async () => {
      await sql`UPDATE notebooks.notebooks SET default_presentation_mode = 'editor' WHERE id = ${notebookId}::uuid`;
    };
    await expect(update()).rejects.toThrow();
    expect((await notebooks.get({ id: notebookId }))?.defaultPresentationMode).toBe(before?.defaultPresentationMode);
  });
});
