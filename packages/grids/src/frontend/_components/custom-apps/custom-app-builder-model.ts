import type { CustomAppBlock, CustomAppDefinition, CustomAppPage } from "../../../custom-apps/contracts";

const mapBlocks = (page: CustomAppPage, update: (block: CustomAppBlock) => CustomAppBlock): CustomAppPage => ({
  ...page,
  rows: page.rows.map((row) => ({
    ...row,
    columns: row.columns.map((column) => ({ ...column, blocks: column.blocks.map(update) })),
  })),
});

const renameMappingKey = <T>(mapping: Record<string, T>, from: string, to: string): Record<string, T> =>
  Object.fromEntries(Object.entries(mapping).map(([key, value]) => [key === from ? to : key, value]));

const renameContextParameter = (source: string, from: string, to: string): string =>
  source.replace(new RegExp(`@params\\.${from}(?![a-zA-Z0-9_])`, "g"), `@params.${to}`);

export const appendCustomAppBlockRow = (
  rows: CustomAppPage["rows"],
  block: CustomAppBlock,
  ids: { rowId: string; columnId: string },
): CustomAppPage["rows"] => [
  ...rows,
  {
    id: ids.rowId,
    columns: [{ id: ids.columnId, span: 12, blocks: [block] }],
  },
];

export const renameCustomAppPage = (definition: CustomAppDefinition, from: string, to: string): CustomAppDefinition => ({
  ...definition,
  startPageId: definition.startPageId === from ? to : definition.startPageId,
  pages: definition.pages.map((page) =>
    mapBlocks(page.id === from ? { ...page, id: to } : page, (block) => {
      if (block.type === "records" && block.rowNavigate?.pageId === from) {
        return { ...block, rowNavigate: { ...block.rowNavigate, pageId: to } };
      }
      if (block.type === "form" && block.onSuccessNavigate?.pageId === from) {
        return { ...block, onSuccessNavigate: { ...block.onSuccessNavigate, pageId: to } };
      }
      if (block.type !== "actions") return block;
      return {
        ...block,
        actions: block.actions.map((action) => (action.kind === "navigate" && action.pageId === from ? { ...action, pageId: to } : action)),
      };
    }),
  ),
});

export const renameCustomAppPageParameter = (
  definition: CustomAppDefinition,
  pageId: string,
  from: string,
  to: string,
): CustomAppDefinition => ({
  ...definition,
  pages: definition.pages.map((page) => {
    const ownsParameter = page.id === pageId;
    const renamedPage = ownsParameter
      ? {
          ...page,
          parameters: renameMappingKey(page.parameters, from, to),
          record: page.record?.id.path === from ? { ...page.record, id: { source: "PARAMS" as const, path: to } } : page.record,
          availableWhen: page.availableWhen ? { query: renameContextParameter(page.availableWhen.query, from, to) } : page.availableWhen,
        }
      : page;
    return mapBlocks(renamedPage, (block) => {
      const availableWhen =
        ownsParameter && block.availableWhen ? { query: renameContextParameter(block.availableWhen.query, from, to) } : block.availableWhen;
      if (block.type === "records" || block.type === "referenced_records") {
        return {
          ...block,
          availableWhen,
          ...(block.type === "records"
            ? {
                source:
                  ownsParameter && block.source.kind === "gql"
                    ? { ...block.source, query: renameContextParameter(block.source.query, from, to) }
                    : block.source,
                rowNavigate:
                  block.rowNavigate?.pageId === pageId
                    ? { ...block.rowNavigate, params: renameMappingKey(block.rowNavigate.params, from, to) }
                    : block.rowNavigate,
              }
            : {}),
          rowActions: block.rowActions?.map((action) => ({
            ...action,
            availableWhen:
              ownsParameter && action.availableWhen
                ? { query: renameContextParameter(action.availableWhen.query, from, to) }
                : action.availableWhen,
            inputs: ownsParameter
              ? Object.fromEntries(
                  Object.entries(action.inputs).map(([name, value]) => [
                    name,
                    value.source === "PARAMS" && value.path === from ? { source: "PARAMS" as const, path: to } : value,
                  ]),
                )
              : action.inputs,
          })),
        };
      }
      if (block.type === "form") {
        return {
          ...block,
          availableWhen,
          fixedValues: ownsParameter
            ? Object.fromEntries(
                Object.entries(block.fixedValues).map(([fieldId, value]) => [
                  fieldId,
                  value.source === "PARAMS" && value.path === from ? { source: "PARAMS" as const, path: to } : value,
                ]),
              )
            : block.fixedValues,
          onSuccessNavigate:
            block.onSuccessNavigate?.pageId === pageId
              ? { ...block.onSuccessNavigate, params: renameMappingKey(block.onSuccessNavigate.params, from, to) }
              : block.onSuccessNavigate,
        };
      }
      if (block.type !== "actions") {
        return {
          ...block,
          availableWhen,
          ...(ownsParameter && (block.type === "metrics" || block.type === "chart") && block.source.kind === "gql"
            ? { source: { ...block.source, query: renameContextParameter(block.source.query, from, to) } }
            : {}),
        } as CustomAppBlock;
      }
      return {
        ...block,
        availableWhen,
        actions: block.actions.map((action) => {
          const actionAvailableWhen =
            ownsParameter && action.availableWhen
              ? { query: renameContextParameter(action.availableWhen.query, from, to) }
              : action.availableWhen;
          if (action.kind === "navigate") {
            return {
              ...action,
              availableWhen: actionAvailableWhen,
              params: Object.fromEntries(
                Object.entries(action.pageId === pageId ? renameMappingKey(action.params, from, to) : action.params).map(
                  ([parameterId, value]) => [
                    parameterId,
                    ownsParameter && value.source === "PARAMS" && value.path === from ? { source: "PARAMS" as const, path: to } : value,
                  ],
                ),
              ),
            };
          }
          return {
            ...action,
            availableWhen: actionAvailableWhen,
            inputs: ownsParameter
              ? Object.fromEntries(
                  Object.entries(action.inputs).map(([name, value]) => [
                    name,
                    value.source === "PARAMS" && value.path === from ? { source: "PARAMS" as const, path: to } : value,
                  ]),
                )
              : action.inputs,
          };
        }),
      };
    });
  }),
});

export const moveCustomAppPage = (definition: CustomAppDefinition, pageId: string, direction: -1 | 1): CustomAppDefinition => {
  const pages = [...definition.pages];
  const index = pages.findIndex((page) => page.id === pageId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= pages.length) return definition;
  [pages[index], pages[target]] = [pages[target]!, pages[index]!];
  return { ...definition, pages };
};

type CustomAppPageParameterUsage =
  | "page record"
  | "page availability"
  | "block availability"
  | "GQL source"
  | "row navigation"
  | "Form binding"
  | "Form success navigation"
  | "row action availability"
  | "Row action input"
  | "action availability"
  | "Navigate action target"
  | "Navigate action source"
  | "Workflow action input";

export const customAppPageParameterUsage = (
  definition: CustomAppDefinition,
  pageId: string,
  parameterId: string,
): CustomAppPageParameterUsage[] => {
  const usage = new Set<CustomAppPageParameterUsage>();
  const contextReference = `@params.${parameterId}`;
  for (const page of definition.pages) {
    if (page.id === pageId && page.record?.id.path === parameterId) usage.add("page record");
    if (page.id === pageId && page.availableWhen?.query.includes(contextReference)) usage.add("page availability");
    for (const row of page.rows) {
      for (const column of row.columns) {
        for (const block of column.blocks) {
          if (page.id === pageId && block.availableWhen?.query.includes(contextReference)) usage.add("block availability");
          if (
            page.id === pageId &&
            (block.type === "records" || block.type === "metrics" || block.type === "chart") &&
            block.source.kind === "gql" &&
            block.source.query.includes(contextReference)
          ) {
            usage.add("GQL source");
          }
          if (block.type === "records" && block.rowNavigate?.pageId === pageId && block.rowNavigate.params[parameterId]) {
            usage.add("row navigation");
          }
          if (block.type === "form") {
            if (
              page.id === pageId &&
              Object.values(block.fixedValues).some((value) => value.source === "PARAMS" && value.path === parameterId)
            )
              usage.add("Form binding");
            if (block.onSuccessNavigate?.pageId === pageId && block.onSuccessNavigate.params[parameterId])
              usage.add("Form success navigation");
          }
          if (block.type === "records" || block.type === "referenced_records") {
            for (const action of block.rowActions ?? []) {
              if (page.id === pageId && action.availableWhen?.query.includes(contextReference)) usage.add("row action availability");
              if (
                page.id === pageId &&
                Object.values(action.inputs).some((value) => value.source === "PARAMS" && value.path === parameterId)
              ) {
                usage.add("Row action input");
              }
            }
          }
          if (block.type !== "actions") continue;
          for (const action of block.actions) {
            if (page.id === pageId && action.availableWhen?.query.includes(contextReference)) usage.add("action availability");
            if (action.kind === "navigate") {
              if (action.pageId === pageId && action.params[parameterId]) usage.add("Navigate action target");
              if (
                page.id === pageId &&
                Object.values(action.params).some((value) => value.source === "PARAMS" && value.path === parameterId)
              ) {
                usage.add("Navigate action source");
              }
            } else if (
              page.id === pageId &&
              Object.values(action.inputs).some((value) => value.source === "PARAMS" && value.path === parameterId)
            ) {
              usage.add("Workflow action input");
            }
          }
        }
      }
    }
  }
  return [...usage];
};

export const removeCustomAppPageParameter = (
  definition: CustomAppDefinition,
  pageId: string,
  parameterId: string,
): CustomAppDefinition => ({
  ...definition,
  pages: definition.pages.map((page) =>
    page.id === pageId
      ? { ...page, parameters: Object.fromEntries(Object.entries(page.parameters).filter(([id]) => id !== parameterId)) }
      : page,
  ),
});
