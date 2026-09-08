import { batch, createMemo, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import type { CustomAppDefinition, CustomAppDiagnostic } from "../../../custom-apps/contracts";

const clone = (definition: CustomAppDefinition): CustomAppDefinition => structuredClone(unwrap(definition));

type CustomAppBuilderSelection =
  | { kind: "page"; pageId: string }
  | { kind: "sidebar-action"; pageId: string; actionId: string }
  | { kind: "block"; pageId: string; blockId: string }
  | { kind: "action"; pageId: string; blockId: string; actionId: string };

// Schema diagnostics use array indices; semantic diagnostics use local IDs.
// Resolve both against the exact draft that produced them before navigating.
export const customAppDiagnosticSelection = (
  definition: CustomAppDefinition,
  diagnostic: CustomAppDiagnostic,
): CustomAppBuilderSelection | null => {
  const path = diagnostic.path;
  let cursor = 0;
  const find = <T extends { id: string }>(items: readonly T[], key: string): T | undefined => {
    if (path[cursor] !== key) return undefined;
    const value = path[cursor + 1];
    cursor += 2;
    return typeof value === "number" ? items[value] : items.find((item) => item.id === value);
  };
  if (path[0] === "sidebar") {
    cursor = 1;
    const action = find(definition.sidebar?.actions ?? [], "actions");
    return action ? { kind: "sidebar-action", pageId: definition.startPageId, actionId: action.id } : null;
  }
  const page = find(definition.pages, "pages");
  if (!page) return null;
  const hasLayoutPath = path[cursor] === "rows";
  const row = find(page.rows, "rows");
  const column = row && find(row.columns, "columns");
  if (hasLayoutPath && !column) return { kind: "page", pageId: page.id };
  const blocks = column?.blocks ?? page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
  const block = find(blocks, "blocks");
  if (!block) return { kind: "page", pageId: page.id };
  const actions = block.type === "actions" ? block.actions : "rowActions" in block ? (block.rowActions ?? []) : [];
  const action = find<{ id: string }>(actions, block.type === "actions" ? "actions" : "rowActions");
  return action
    ? { kind: "action", pageId: page.id, blockId: block.id, actionId: action.id }
    : { kind: "block", pageId: page.id, blockId: block.id };
};

const normalizeSelection = (definition: CustomAppDefinition, selection: CustomAppBuilderSelection): CustomAppBuilderSelection => {
  const page = definition.pages.find((page) => page.id === selection.pageId);
  if (!page)
    return {
      kind: "page",
      pageId: (definition.pages.find((page) => page.id === definition.startPageId) ?? definition.pages[0]!).id,
    };
  if (selection.kind === "sidebar-action")
    return definition.sidebar?.actions.some((action) => action.id === selection.actionId) ? selection : { kind: "page", pageId: page.id };
  if (!("blockId" in selection)) return selection;
  const block = page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks)).find((block) => block.id === selection.blockId);
  if (!block) return { kind: "page", pageId: page.id };
  if (selection.kind === "block") return selection;
  const actions =
    block.type === "actions"
      ? block.actions
      : block.type === "records" || block.type === "referenced_records"
        ? (block.rowActions ?? [])
        : [];
  return actions.some((action) => action.id === selection.actionId) ? selection : { kind: "block", pageId: page.id, blockId: block.id };
};

export const createCustomAppBuilderState = (initial: CustomAppDefinition) => {
  const [definition, setDefinition] = createStore(clone(initial));
  const [saved, setSaved] = createSignal(JSON.stringify(initial));
  const [version, setVersion] = createSignal(0);
  const [selection, setSelection] = createSignal<CustomAppBuilderSelection>(
    normalizeSelection(initial, { kind: "page", pageId: initial.startPageId }),
  );
  const normalizeCurrentSelection = () => setSelection((current) => normalizeSelection(definition, current));
  const dirty = createMemo(() => JSON.stringify(definition) !== saved());

  const set = (next: CustomAppDefinition) =>
    batch(() => {
      setDefinition(reconcile(clone(next), { key: "id" }));
      normalizeCurrentSelection();
      setVersion((current) => current + 1);
    });

  return {
    draft: () => definition,
    snapshot: () => clone(definition),
    version,
    dirty,
    set,
    selection,
    select: (next: CustomAppBuilderSelection) => setSelection(normalizeSelection(definition, next)),
    updateBlock: (
      pageId: string,
      blockId: string,
      update: (
        block: CustomAppDefinition["pages"][number]["rows"][number]["columns"][number]["blocks"][number],
      ) => CustomAppDefinition["pages"][number]["rows"][number]["columns"][number]["blocks"][number],
    ) => {
      const pageIndex = definition.pages.findIndex((page) => page.id === pageId);
      const page = definition.pages[pageIndex];
      if (!page) return;
      for (const [rowIndex, row] of page.rows.entries()) {
        for (const [columnIndex, column] of row.columns.entries()) {
          const blockIndex = column.blocks.findIndex((block) => block.id === blockId);
          if (blockIndex < 0) continue;
          batch(() => {
            setDefinition("pages", pageIndex, "rows", rowIndex, "columns", columnIndex, "blocks", blockIndex, (block) =>
              update(structuredClone(unwrap(block))),
            );
            normalizeCurrentSelection();
            setVersion((current) => current + 1);
          });
          return;
        }
      }
    },
    replace: (next: CustomAppDefinition) =>
      batch(() => {
        setDefinition(reconcile(clone(next), { key: "id" }));
        normalizeCurrentSelection();
        setSaved(JSON.stringify(next));
        setVersion((current) => current + 1);
      }),
    markSaved: (snapshot: CustomAppDefinition) => setSaved(JSON.stringify(snapshot)),
  };
};
