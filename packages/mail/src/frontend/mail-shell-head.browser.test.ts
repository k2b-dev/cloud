import { browserName } from "../../../ui/test/browser";
import { defineMailShellPart } from "./mail-shell.browser-run";

await defineMailShellPart(import.meta.path, "head", browserName, process.env);
