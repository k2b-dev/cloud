import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { currentActorUser, gateBaseAtAccess, gridsAccessContext } from "../../../../../api/permissions";
import { ssr } from "../../../../../config";
import { gridsService } from "../../../../../service";
import FormulaReferenceWindow from "../../../../_components/fields/FormulaReferenceWindow.island";
import { resolveGridsMessages } from "../../../../messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = resolveGridsMessages(getLocale(c));
  c.get("page").title = t.formulaReference;
  const baseSlug = c.req.param("baseId")!;
  const tableSlug = c.req.param("tableId")!;
  const base = await gridsService.base.getByShortId(baseSlug);

  if (!base) return ssr.error(c, 404, { layout: "minimal" });

  const table = await gridsService.table.getByShortIdForBase(base.id, tableSlug);
  if (!table) return ssr.error(c, 404, { layout: "minimal" });

  const user = currentActorUser(c);
  if (!user) return ssr.error(c, 403, { layout: "minimal" });

  if (!(await gateBaseAtAccess(gridsAccessContext(c), base.id, "read")).ok) return ssr.error(c, 403, { layout: "minimal" });

  const fields = await gridsService.field.listByTable(table.id);
  const currentFieldId = new URL(c.req.url).searchParams.get("field");

  return () => <FormulaReferenceWindow tableName={table.name} fields={fields} currentFieldId={currentFieldId} />;
});
