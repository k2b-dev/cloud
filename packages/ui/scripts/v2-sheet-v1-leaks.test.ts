import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { v1Leaks } from "./v2-sheet-v1-leaks";

test("the chart sheet that v2.css carries has no v1 rule outside a chart", async () => {
  expect(v1Leaks(await readFile(new URL("../src/styles/chart.css", import.meta.url), "utf8"))).toEqual([]);
});

test("v2 rules and chart rules pass, in either scope and inside at-rules", () => {
  expect(
    v1Leaks(
      [
        ".k2-ui .k2-row{color:red}",
        ":is(.k2b-ui,.k2-ui) .k2b-chart{display:block}",
        ".k2b-ui .k2b-chart__svg>svg,.k2-ui .k2b-chart__svg>svg{width:100%}",
        "@media (forced-colors:active){.k2-ui .k2b-chart[data-interactive=true]:focus-visible{outline:2px solid}}",
        ":where(.k2-ui .k2b-chart:not(.k2b-ui *)) *{box-sizing:border-box}",
        ".k2-ui [popover].k2b-tooltip.k2b-chart__tooltip{position:fixed}",
        ".k2-ui svg[data-calendar] [data-calendar-pinned]{transform:none}",
      ].join(""),
    ),
  ).toEqual([]);
});

test("a v1 scope, its reset and a general hint rule are leaks", () => {
  expect(v1Leaks(".k2b-ui{color:red}")).toEqual([".k2b-ui"]);
  expect(v1Leaks(".k2b-ui *,.k2b-ui ::before{box-sizing:border-box}")).toEqual([".k2b-ui *", ".k2b-ui ::before"]);
  expect(v1Leaks(".k2b-ui [popover].k2b-tooltip{position:fixed}")).toEqual([".k2b-ui [popover].k2b-tooltip"]);
  // a chart named only in :not() does not hold the rule on a chart
  expect(v1Leaks(".k2b-ui :not(.k2b-chart) .k2b-button{color:red}")).toEqual([".k2b-ui :not(.k2b-chart) .k2b-button"]);
  expect(v1Leaks("@media print{.k2b-ui .k2b-button{display:none}}")).toEqual([".k2b-ui .k2b-button"]);
});
