import { expect, test } from "bun:test";
import { readShippedCssRules } from "./css-contract-test-helpers";

const rules = readShippedCssRules(import.meta.dir);
const body = (selector: string) =>
  rules
    .filter((rule) => rule.selector === selector)
    .map((rule) => rule.body)
    .join("\n");

test("activity details keep semantic failure colours and a small marker outside the initials", () => {
  for (const tone of ["warning", "danger"]) {
    expect(body(`.k2b-ui .k2b-activity__entry[data-tone="${tone}"] .k2b-activity__detail`)).toContain(`color: var(--k2b-${tone}-text)`);
  }
  const marker = body(".k2b-ui .k2b-activity__icon");
  expect(marker).toContain("width: 12px");
  expect(marker).toContain("height: 12px");
  expect(marker).toContain("inset: auto -6px -4px auto");
  expect(marker).toContain("outline: 2px solid var(--k2b-activity-row-surface, transparent)");
  expect(marker).not.toContain("background:");
});

test("timeline padding is cancelled symmetrically so avatar and section title share an edge", () => {
  const list = body(".k2b-ui .k2b-activity");
  const row = body(".k2b-ui .k2b-activity__entry");
  expect(list).toContain("margin: 0 -0.75rem");
  expect(list).toContain("padding: 0");
  expect(row).toContain("padding: 0.5rem 0.75rem");
  expect(body(".k2b-ui .k2b-activity-dialog__list > .k2b-activity")).toContain("margin-inline: 0");
});

test("only compact names clip, without removing the complete actor from the accessible DOM", () => {
  expect(body('.k2b-ui .k2b-activity[data-density="compact"] .k2b-activity__actor')).toContain("white-space: pre");
  expect(body('.k2b-ui .k2b-activity[data-density="compact"] .k2b-activity__actor-name')).toContain("text-overflow: ellipsis");
  expect(body(".k2b-ui .k2b-activity__text")).not.toContain("overflow: hidden");
});
