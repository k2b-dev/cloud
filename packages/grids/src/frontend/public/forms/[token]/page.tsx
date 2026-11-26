import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { toPublicForm } from "../../../../api/form-api-shared";
import { toPublicFields } from "../../../../api/public-dto";
import { ssr } from "../../../../config";
import { planFormComputedFields } from "../../../../form-computed-fields";
import { gridsService } from "../../../../service";
import { materializeFormRenderDefaults } from "../../../../service/form-render-defaults";
import { resolveGridsMessages } from "../../../messages";
import { PublicFormScreen, PublicFormUnavailable } from "./PublicFormScreen";

/**
 * Public form rendering page. Anonymous, no auth required.
 * URL: /share/grids/forms/:token
 *
 * Bare layout — NO `<Layout>` chrome (no header / nav / sidebar). The
 * form page is a single self-contained surface optimised for mobile;
 * MinimalLayout's footer carries the legal links and the language and
 * theme settings.
 *
 * SSR fetches the form by its public token + the parent table's fields,
 * then hands both to the inline-submit island. The island POSTs the user
 * payload to /api/grids/forms/public/:token/submit (which is also gated
 * by token, so a 404 + an authoritative form-config-aware filter run
 * on the server).
 */
export default ssr<AuthContext>(async (c) => {
  const token = c.req.param("token")!;
  const locale = getLocale(c);
  const { t } = resolveGridsMessages(locale);

  const form = await gridsService.form.getByPublicToken(token);
  if (!form || !form.isActive) {
    c.status(404);
    c.header("Cache-Control", "private, no-store");
    c.get("page").title = t.formNotFound;
    return () => (
      <MinimalLayout c={c} ui="v2">
        <PublicFormUnavailable title={t.formNotFound} text={t.formUnavailable} />
      </MinimalLayout>
    );
  }

  // Only ship field metadata for fields the form actually exposes
  // AND only for user_input entries. form_value entries' fieldIds are
  // server-applied — the anonymous HTML must not contain their target
  // field metadata (would leak schema details, even if values are
  // applied server-side).
  const userInputIds = new Set(form.config.fields.filter((e) => e.kind === "user_input").map((e) => e.fieldId));
  const liveFields = await gridsService.field.listByTable(form.tableId);
  const summary = planFormComputedFields(
    (form.config.computedFields ?? []).map((entry) => entry.fieldId),
    userInputIds,
    liveFields,
  );
  const visibleIds = new Set([...userInputIds, ...(summary?.fields ?? []).map((field) => field.id)]);
  const internalFields = liveFields.filter((f) => visibleIds.has(f.id));
  const fields = await toPublicFields(internalFields);
  const publicFieldsByInternalId = new Map<string, (typeof fields)[number]>();
  for (const [index, field] of internalFields.entries()) {
    const publicField = fields[index];
    if (publicField) publicFieldsByInternalId.set(field.id, publicField);
  }
  const fieldsById = new Map(liveFields.map((field) => [field.id, field]));
  const inlineTargetFields: Record<string, typeof fields> = {};
  for (const entry of form.config.fields) {
    if (entry.kind !== "user_input" || !entry.inlineCreate?.enabled) continue;
    const relationField = fieldsById.get(entry.fieldId);
    if (relationField?.type !== "relation") continue;
    const targetTableId = (relationField.config as { targetTableId?: unknown }).targetTableId;
    if (typeof targetTableId !== "string") continue;
    const publicTargetTableId = (publicFieldsByInternalId.get(entry.fieldId)?.config as { targetTableId?: unknown } | undefined)
      ?.targetTableId;
    if (typeof publicTargetTableId !== "string") continue;
    const allowedIds = new Set((entry.inlineCreate.fields ?? []).map((inlineField) => inlineField.fieldId));
    const targetFields = await gridsService.field.listByTable(targetTableId);
    inlineTargetFields[publicTargetTableId] = await toPublicFields(targetFields.filter((field) => allowedIds.has(field.id)));
  }

  c.get("page").title = form.config.title ?? form.name;
  c.get("page").description = form.config.description ?? undefined;
  const dateConfig = await getDateConfig(c);

  // Mirrors the public API DTO: only form render config, no table ids,
  // share tokens, owner metadata, timestamps, or server-applied values.
  const safeForm = await toPublicForm(materializeFormRenderDefaults(form, internalFields, { dateConfig }));

  return () => (
    <MinimalLayout c={c} ui="v2">
      <PublicFormScreen
        publicToken={token}
        form={safeForm}
        fields={fields}
        inlineTargetFields={inlineTargetFields}
        dateConfig={dateConfig}
      />
    </MinimalLayout>
  );
});
