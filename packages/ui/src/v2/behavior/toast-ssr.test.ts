import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { overlays } from "@ui-sdk/core/overlays";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../test/ssr-test-plugin";

// The toast module is a Solid module (`.tsx`), compiled by the registered plugin, so it is imported after it.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-v2-toast-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { useToaster } = await import("./toast");

// A server renders a page per request. A toast shown during that render must stay with its own toaster: one kept in a
// process-wide registry would outlive the request and pile up across requests.
test("a toast shown during a server render leaves the process-wide overlay registry as it was", () => {
  const before = overlays.entries().length;
  for (let request = 0; request < 3; request++) {
    renderToString(() =>
      createComponent(() => {
        const { toaster, Region } = useToaster();
        toaster.show({ title: `Gespeichert ${request}` });
        return createComponent(Region, { toast: () => null });
      }, {}),
    );
  }
  expect(overlays.entries().length).toBe(before);
});
