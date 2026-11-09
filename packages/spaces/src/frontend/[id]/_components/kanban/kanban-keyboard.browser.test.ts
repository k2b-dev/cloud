import { browserName } from "../../../../../../ui/test/browser";
import { defineKanbanPart } from "./kanban-board.browser-run";

await defineKanbanPart(import.meta.path, "keyboard", "the Kanban board moves cards by keyboard and says where", browserName);
