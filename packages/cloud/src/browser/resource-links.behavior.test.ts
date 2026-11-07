import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  test("Ctrl+Shift+V pastes a Cloud link as plain text; the next paste is recognized again", async () => {
    const dom = createDomTestHarness();
    const shell = document.createElement("script");
    shell.id = "cloud-shell-data";
    shell.type = "application/json";
    shell.textContent = JSON.stringify({ cloudOrigin: "https://cloud.example" });
    document.body.append(shell);
    try {
      const { pastedCloudLink } = await import("./resource-links");
      const paste = () =>
        ({
          timeStamp: performance.now(),
          clipboardData: { getData: () => "https://cloud.example/app/spaces/Spc001?item=Itm001" },
        }) as unknown as ClipboardEvent;

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "V", ctrlKey: true, shiftKey: true }));
      expect(pastedCloudLink(paste())).toBeNull();
      expect(pastedCloudLink(paste())).toBe("https://cloud.example/app/spaces/Spc001?item=Itm001");

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "◊", code: "KeyV", metaKey: true, altKey: true, shiftKey: true }));
      expect(pastedCloudLink(paste())).toBeNull();

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }));
      expect(pastedCloudLink(paste())).toBe("https://cloud.example/app/spaces/Spc001?item=Itm001");
    } finally {
      shell.remove();
      dom.cleanup();
    }
  });
}
