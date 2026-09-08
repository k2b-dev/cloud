import { type Field, ShortIdSchema } from "../contracts";
import type { CustomAppCapabilities, CustomAppFormBlock, CustomAppPage, CustomAppSidebarAction } from "../custom-apps/contracts";
import { customAppFormInlineTargetTableIds } from "../custom-apps/form-capability";
import { customAppFormMatchesPublishedCapability } from "../custom-apps/form-runtime";
import { customAppBindingRecordTableId } from "../custom-apps/value-bindings";
import { listByTable } from "./fields";
import { get as getForm } from "./forms";
import { resolvePublicId, resolvePublicIds } from "./public-resources";

type PublishedFormSurface = CustomAppFormBlock | Extract<CustomAppSidebarAction, { kind: "form" }>;

const remapFixedValues = <Value>(values: Record<string, Value>, ids: Map<string, string>): Record<string, Value> =>
  Object.fromEntries(Object.entries(values).map(([fieldId, value]) => [ids.get(fieldId)!, value]));

export const resolvePublishedCustomAppForm = async (input: {
  surface: PublishedFormSurface;
  page?: CustomAppPage;
  capabilities: CustomAppCapabilities;
}) => {
  const capability = input.page
    ? input.capabilities.forms.find(
        (candidate) => "pageId" in candidate && candidate.pageId === input.page!.id && candidate.blockId === input.surface.id,
      )
    : input.capabilities.forms.find((candidate) => "sidebarActionId" in candidate && candidate.sidebarActionId === input.surface.id);
  if (!capability) return null;
  const publicFixedFieldIds = Object.keys(input.surface.fixedValues);
  if (
    !ShortIdSchema.safeParse(input.surface.formId).success ||
    publicFixedFieldIds.some((fieldId) => !ShortIdSchema.safeParse(fieldId).success)
  ) {
    return null;
  }
  const [formId, fixedFieldIds] = await Promise.all([
    resolvePublicId("form", input.surface.formId),
    resolvePublicIds("field", publicFixedFieldIds),
  ]);
  if (formId !== capability.formId || fixedFieldIds.size !== publicFixedFieldIds.length) return null;
  const fixedValues = remapFixedValues(input.surface.fixedValues, fixedFieldIds);
  const bindingTableReferences = new Map<string, string>();
  for (const [fieldId, binding] of Object.entries(fixedValues)) {
    if (binding.source === "LITERAL" || binding.source === "AUTH") continue;
    const tableId = input.page ? customAppBindingRecordTableId(binding, input.page) : null;
    if (!tableId || !ShortIdSchema.safeParse(tableId).success) return null;
    bindingTableReferences.set(fieldId, tableId);
  }
  const tableIds = await resolvePublicIds("table", [...new Set(bindingTableReferences.values())]);
  const bindingTableIds = new Map<string, string>();
  for (const [fieldId, reference] of bindingTableReferences) {
    const tableId = tableIds.get(reference);
    if (!tableId) return null;
    bindingTableIds.set(fieldId, tableId);
  }
  const form = await getForm(formId);
  if (!form) return null;
  const fields = await listByTable(form.tableId, true);
  const inlineTargetFields: Field[] = (
    await Promise.all(customAppFormInlineTargetTableIds(form.config, fields).map((tableId) => listByTable(tableId, true)))
  ).flat();
  if (
    !customAppFormMatchesPublishedCapability({
      fixedValues,
      bindingTableIds,
      form,
      fields,
      inlineTargetFields,
      capability,
    })
  ) {
    return null;
  }
  return { form, fields, inlineTargetFields, fixedValues } as const;
};
