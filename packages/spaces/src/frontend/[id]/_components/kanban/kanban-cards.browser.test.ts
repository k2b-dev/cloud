import { browserName } from "../../../../../../ui/test/browser";
import { defineKanbanPart } from "./kanban-board.browser-run";

await defineKanbanPart(
  import.meta.path,
  "cards",
  "Kanban cards show descriptions, workers and reactions, also beside Detail",
  browserName,
  process.env,
);
