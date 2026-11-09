import { browserName } from "../../../../../../ui/test/browser";
import { defineKanbanPart } from "./kanban-board.browser-run";

await defineKanbanPart(import.meta.path, "columns", "the Kanban board's automatic columns and column moves", browserName);
