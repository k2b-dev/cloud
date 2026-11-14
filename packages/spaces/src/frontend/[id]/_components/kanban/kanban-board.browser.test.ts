import { browserName } from "../../../../../../ui/test/browser";
import { defineKanbanPart } from "./kanban-board.browser-run";

await defineKanbanPart(
  import.meta.path,
  "board",
  "the Kanban board lays out, reveals card controls and moves cards by touch",
  browserName,
  process.env,
);
