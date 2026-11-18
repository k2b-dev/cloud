import { test } from "bun:test";
import { browserName } from "../../../ui/test/browser";
import { defineMailShellPart } from "./mail-shell.browser-run";

if (browserName !== "chromium") test.skip("Folder Long Tasks require Chromium", () => {});
else await defineMailShellPart(import.meta.path, "performance", browserName, { ...process.env, MAIL_SHELL_FOLDER_SCALE: "1" });
