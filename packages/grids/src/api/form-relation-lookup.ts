import type { AuthContext } from "@k2b/cloud/server";
import { getDateConfig, jsonResponse } from "@k2b/cloud/server";
import type { Context } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { customAppFormRelationScope } from "../service/custom-app-form-relations";
import { listByTable } from "../service/fields";
import type { Form } from "../service/forms";
import { projectPublicIds, resolvePublicIds } from "../service/public-resources";
import { lookupRecords } from "../service/relation-labels";
import { apiMessages } from "./messages";

export const formRelationLookupDescription = describeRoute({
  tags: ["Grids:Form"],
  summary: "Search eligible records for a filtered relation input",
  responses: {
    200: jsonResponse(z.object({ items: z.array(z.object({ id: ShortIdSchema, label: z.string() })) }), "Eligible record labels"),
  },
});

/** Caller authorizes this Form through Base Write or its active public token. */
export const lookupFilteredFormRelation = async (context: Context<AuthContext>, form: Form) => {
  const fields = await listByTable(form.tableId);
  const scope = await customAppFormRelationScope(form, fields, []);
  const target = scope?.targets.find((target) => target.field.shortId === context.req.param("fieldId") && target.filter);
  if (!target) return context.json({ message: apiMessages(context).formNotFound }, 404);
  const query = z
    .object({
      _search: z.string().max(200).default(""),
      _limit: z.coerce.number().int().min(1).max(50).default(10),
      _exclude: z
        .string()
        .max(7000)
        .default("")
        .transform((value) => value.split(",").filter(Boolean))
        .pipe(z.array(ShortIdSchema).max(1000)),
    })
    .safeParse(context.req.query());
  if (!query.success) return context.json({ message: apiMessages(context).invalidFormSubmission }, 400);
  const excluded = await resolvePublicIds("record", query.data._exclude);
  const result = await lookupRecords({
    targetTableId: target.tableId,
    filter: target.filter,
    timeZone: getDateConfig(context).timeZone,
    q: query.data._search,
    limit: query.data._limit,
    excludeIds: [...excluded.values()],
    labelSnapshot: {
      fields: target.targetFields,
      presentable: target.labels,
      tableKind: target.tableKind,
      recordSource: target.recordSource,
    },
    untitledLabel: apiMessages(context).untitledRecord,
  });
  const ids = await projectPublicIds(
    "record",
    result.items.map((item) => item.id),
  );
  return context.json({ items: result.items.map((item) => ({ id: ids.get(item.id)!, label: item.label })) });
};
