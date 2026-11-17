import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { openPhoneHelp, until } from "./layout-help-phone.test-fixture";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("on a phone without the panel, Help opens as the bottom sheet", async () => {
    const help = await openPhoneHelp();
    try {
      const sheet = () => help.dom.document.querySelector("dialog[open].cloud-help-sheet");
      await until(sheet);
      expect(sheet()).not.toBeNull();
      expect(sheet()!.querySelector(".k2b-bottom-sheet__handle")).not.toBeNull();
    } finally {
      await help.cleanup();
    }
  });
