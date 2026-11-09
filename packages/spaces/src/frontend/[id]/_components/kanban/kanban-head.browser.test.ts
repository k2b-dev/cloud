import { browserName } from "../../../../../../ui/test/browser";
import { defineKanbanPart } from "./kanban-board.browser-run";

await defineKanbanPart(import.meta.path, "head", "the Kanban head filters the board and lists its shortcuts", browserName);
