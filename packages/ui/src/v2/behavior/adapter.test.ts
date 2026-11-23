import { expect, test } from "bun:test";
import { toSolidAttrs } from "./adapter";

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
