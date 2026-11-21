import { browserName } from "../../../../../../ui/test/browser";
import { defineKanbanPart } from "./kanban-board.browser-run";

await defineKanbanPart(
  import.meta.path,
  "board",
  "the Kanban board lays out, keeps its place on hydration, and folds columns",
  browserName,
  process.env,
);
