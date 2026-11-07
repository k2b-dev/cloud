import { sql } from "@k2b/cloud";
import { acceptanceProvider } from "../../../scripts/fixtures/code-acceptance-provider";
import { gridsCapabilities } from "./capabilities";
import { migrate } from "./migrate";
import { gridsService } from "./service";

/** Load the real Grids provider under its own aliases at the checked cross-app test boundary. */
export const provider = acceptanceProvider("grids", gridsCapabilities);

export async function prepare(input: { baseId: string; tableId: string; base: string; table: string; userId: string }) {
  await migrate();
  await sql`INSERT INTO grids.bases(id,short_id,name) VALUES(${input.baseId}::uuid,${input.base},'Code owner')`;
  await sql`INSERT INTO grids.tables(id,short_id,base_id,name) VALUES(${input.tableId}::uuid,${input.table},${input.baseId}::uuid,'Items')`;
  const field = await gridsService.field.create({ tableId: input.tableId, name: "Name", type: "text", presentable: true }, input.userId);
  if (!field.ok) throw field.error;
  return { fieldId: field.data.id, fieldShortId: field.data.shortId };
}
