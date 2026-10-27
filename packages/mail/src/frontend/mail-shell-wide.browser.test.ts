import { browserName } from "../../../ui/test/browser";
import { defineMailShellPart } from "./mail-shell.browser-run";

await defineMailShellPart(import.meta.path, "wide", browserName, process.env);
