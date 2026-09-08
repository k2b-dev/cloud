import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { CustomAppDefinition } from "../../../custom-apps/contracts";
import { applyCustomAppBlockDrop } from "./custom-app-builder-dnd";
import { createCustomAppBuilderState } from "./custom-app-builder-state";

const definition = (): CustomAppDefinition => ({
  schemaVersion: 5,
  kind: "grids.custom-app",
  id: "APP001",
  baseId: "BASE01",
  name: "App",
  startPageId: "home",
  pages: [
    {
      id: "home",
      title: "Home",
      navigation: { visible: true },
      parameters: {},
      rows: [
        {
          id: "row-1",
          columns: [
            {
              id: "column-1",
              span: 12,
              blocks: [
                { id: "copy", type: "markdown", markdown: "Before" },
                {
                  id: "records",
                  type: "records",
                  searchable: true,
                  pageSize: 25,
                  source: { kind: "view", viewId: "VIEW01" },
                  display: { kind: "table", columnIds: ["FIELD1"] },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe("createCustomAppBuilderState", () => {
  test("sidebar actions have their own selection and fall back after removal or restore", () =>
    createRoot((dispose) => {
      const initial = definition();
      initial.sidebar = {
        actions: [{ id: "request", kind: "form", formId: "FORM01", label: "Request", tone: "success", fixedValues: {} }],
      };
      const state = createCustomAppBuilderState(initial);
      state.select({ kind: "sidebar-action", pageId: "home", actionId: "request" });
      const selection = state.selection();
      const next = state.snapshot();
      next.sidebar!.actions[0]!.label = "Renamed";
      state.set(next);
      expect(state.selection()).toBe(selection);
      state.markSaved(initial);
      expect(state.snapshot().sidebar?.actions[0]?.label).toBe("Renamed");
      expect(state.selection()).toBe(selection);
      state.replace(definition());
      expect(state.selection()).toEqual({ kind: "page", pageId: "home" });
      state.select({ kind: "sidebar-action", pageId: "home", actionId: "missing" });
      expect(state.selection()).toEqual({ kind: "page", pageId: "home" });
      state.set(initial);
      state.select({ kind: "sidebar-action", pageId: "home", actionId: "request" });
      state.select({ kind: "page", pageId: "home" });
      expect(state.selection()).toEqual({ kind: "page", pageId: "home" });
      dispose();
    }));
  test("falls back to the page after removing the selected block without resurrecting it", () =>
    createRoot((dispose) => {
      const state = createCustomAppBuilderState(definition());
      state.select({ kind: "block", pageId: "home", blockId: "copy" });
      const next = state.snapshot();
      next.pages[0]!.rows[0]!.columns[0]!.blocks.splice(0, 1);
      state.set(next);
      expect(state.selection()).toEqual({ kind: "page", pageId: "home" });
      state.set(definition());
      expect(state.selection()).toEqual({ kind: "page", pageId: "home" });
      dispose();
    }));

  test("keeps selection when moving a block and when a save finishes after newer edits", () =>
    createRoot((dispose) => {
      const state = createCustomAppBuilderState(definition());
      state.select({ kind: "block", pageId: "home", blockId: "copy" });
      const selected = state.selection();
      const saved = state.snapshot();
      const next = state.snapshot();
      next.pages[0] = applyCustomAppBlockDrop(
        next.pages[0]!,
        "copy",
        { kind: "stack", targetBlockId: "records", edge: "after" },
        { rowIds: ["row-a", "row-b"], columnIds: ["column-a", "column-b", "column-c"] },
      );
      state.set(next);
      expect(state.draft().pages[0]!.rows[0]!.columns[0]!.blocks.map((block) => block.id)).toEqual(["records", "copy"]);
      expect(state.selection()).toBe(selected);
      state.updateBlock("home", "copy", (block) => (block.type === "markdown" ? { ...block, markdown: "Newer edit" } : block));
      state.markSaved(saved);
      expect(state.selection()).toBe(selected);
      expect(state.snapshot().pages[0]!.rows[0]!.columns[0]!.blocks.find((block) => block.id === "copy")).toMatchObject({
        markdown: "Newer edit",
      });
      dispose();
    }));

  test("resolves removed actions to their block and never selects an action in a different block", () =>
    createRoot((dispose) => {
      const initial = definition();
      initial.pages[0]!.rows[0]!.columns[0]!.blocks.push({
        id: "actions",
        type: "actions",
        actions: [{ id: "go", kind: "navigate", label: "Home", pageId: "home", params: {}, history: "push" }],
      });
      const state = createCustomAppBuilderState(initial);
      state.select({ kind: "action", pageId: "home", blockId: "actions", actionId: "go" });
      expect(state.selection().kind).toBe("action");
      state.select({ kind: "action", pageId: "home", blockId: "copy", actionId: "go" });
      expect(state.selection()).toEqual({ kind: "block", pageId: "home", blockId: "copy" });
      state.select({ kind: "action", pageId: "home", blockId: "actions", actionId: "go" });
      state.updateBlock("home", "actions", (block) => ({ id: block.id, type: "markdown", markdown: "Replaced" }));
      expect(state.selection()).toEqual({ kind: "block", pageId: "home", blockId: "actions" });
      dispose();
    }));

  test("page switch, removed page and restored draft retain a valid inspector context", () =>
    createRoot((dispose) => {
      const initial = definition();
      initial.pages.push({ ...structuredClone(initial.pages[0]!), id: "other", title: "Other" });
      const state = createCustomAppBuilderState(initial);
      state.select({ kind: "block", pageId: "home", blockId: "copy" });
      state.select({ kind: "page", pageId: "other" });
      expect(state.selection()).toEqual({ kind: "page", pageId: "other" });
      state.select({ kind: "block", pageId: "other", blockId: "copy" });
      state.replace(definition());
      expect(state.selection()).toEqual({ kind: "page", pageId: "home" });
      state.select({ kind: "page", pageId: "other" });
      expect(state.selection()).toEqual({ kind: "page", pageId: "home" });
      dispose();
    }));

  test("preserves unchanged block identities across keyed updates", () =>
    createRoot((dispose) => {
      const state = createCustomAppBuilderState(definition());
      const records = state.draft().pages[0]?.rows[0]?.columns[0]?.blocks[1];
      state.updateBlock("home", "copy", (block) => (block.type === "markdown" ? { ...block, markdown: "After" } : block));
      expect(state.draft().pages[0]?.rows[0]?.columns[0]?.blocks[1]).toBe(records);
      expect(state.draft().pages[0]?.rows[0]?.columns[0]?.blocks[0]).toMatchObject({ markdown: "After" });
      dispose();
    }));
});
