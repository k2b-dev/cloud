import { browserName } from "../../../ui/test/browser";
import { defineMailShellPart } from "./mail-shell.browser-run";

await defineMailShellPart(import.meta.path, "layout", browserName, process.env);
