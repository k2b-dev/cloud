import { expect, mock, spyOn, test } from "bun:test";
import { isServer } from "solid-js/web";
import { openPhoneHelp, until } from "./layout-help-phone.test-fixture";

// The sheet's code arrives as its own chunk; here it fails to load, as after a deploy or offline.
mock.module("./layout-help-sheet", () => Promise.reject(new Error("the help sheet's chunk did not load")));

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("when the help sheet's code does not load, Help still opens, as the dialog, and the error is reported", async () => {
    const reported = spyOn(globalThis, "reportError").mockImplementation(() => {});
    const help = await openPhoneHelp();
    try {
      await until(() => help.dialogCore.isOpen());
      expect(help.dialogCore.isOpen()).toBe(true);
      expect(help.dom.document.querySelector("dialog[open].cloud-help-sheet")).toBeNull();
      expect(reported).toHaveBeenCalledTimes(1);
    } finally {
      await help.cleanup();
      reported.mockRestore();
    }
  });
