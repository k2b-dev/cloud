import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { registerSsrTestPlugin } from "../../../test/ssr-test-plugin";

// The adapter is a Solid module (`.tsx`): it is compiled by the registered plugin, so it is imported after it.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-v2-adapter-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { toSolidAttrs } = await import("./adapter");

// Error class: core writes boolean attributes as "" the HTML way; Solid 1 sets them as properties (client) or drops
// falsy ones (server), so `hidden: ""` showed a closed tooltip.
test("boolean attributes written as an empty string stay on; data, value and undefined attributes keep their meaning", () => {
  expect(toSolidAttrs({ hidden: "", disabled: "", inert: "", "data-open": "", value: "", "aria-label": undefined, id: "a" })).toEqual({
    hidden: true,
    disabled: true,
    inert: true,
    "data-open": "",
    value: "",
    id: "a",
  });
});
