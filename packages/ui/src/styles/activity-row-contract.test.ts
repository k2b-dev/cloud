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

test("one bleed drives the timeline's margin, row padding, rail and day line, so the avatar keeps the title's edge", () => {
  const list = body(".k2b-ui .k2b-activity");
  const row = body(".k2b-ui .k2b-activity__entry");
  expect(body(".k2b-ui :is(.k2b-activity, .k2b-activity-dialog__list)")).toContain("--k2b-activity-bleed: 0.5rem");
  expect(list).toContain("margin: 0 calc(-1 * var(--k2b-activity-bleed))");
  expect(list).toContain("padding: 0");
  // Mail's feed rows stand outside a list and keep the 0.75rem bleed.
  expect(row).toContain("padding: 0.5rem var(--k2b-activity-bleed, 0.75rem)");
  expect(body(".k2b-ui .k2b-activity__day")).toContain("padding: 0.5rem var(--k2b-activity-bleed)");
  for (const rail of [".k2b-ui .k2b-activity > li::before", ".k2b-ui .k2b-activity > li.k2b-activity__entry::after"])
    expect(body(rail), rail).toContain("left: calc(var(--k2b-activity-bleed) + 11px)");
  expect(body(".k2b-ui .k2b-activity-dialog__list")).toContain("margin-inline: calc(-0.5rem - var(--k2b-activity-bleed))");
  expect(body(".k2b-ui .k2b-activity-dialog__list > .k2b-activity")).toContain("margin-inline: 0");
});

test("an embedded timeline's row surface keeps at least 6px from a framed section's edge", () => {
  const rem = (value: string) => Number.parseFloat(value) * (value.endsWith("rem") ? 16 : 1);
  const bleed = /--k2b-activity-bleed:\s*([\d.]+(?:rem|px))/.exec(body(".k2b-ui :is(.k2b-activity, .k2b-activity-dialog__list)"))?.[1];
  // The inline padding is the column's text edge, `var(--k2b-gutter)` (K5): 20 px, 16 px on a phone; the phone value
  // is the one that must keep the distance.
  const padding = /padding:\s*[\d.]+(?:rem|px)\s+var\(--k2b-gutter\)/.test(body('.k2b-ui .k2b-section[data-frame="line"]'))
    ? rules
        .flatMap((rule) => [...rule.body.matchAll(/--k2b-gutter:\s*([\d.]+px)/g)].map((match) => match[1]!))
        .sort((a, b) => rem(a) - rem(b))[0]
    : undefined;
  expect(bleed).toBeDefined();
  expect(padding).toBeDefined();
  expect(rem(padding!) - rem(bleed!)).toBeGreaterThanOrEqual(6);
});

test("icons in the 24px activity avatars read at 14px", () => {
  expect(body(".k2b-ui .k2b-activity__avatar .k2b-avatar > i")).toContain("font-size: 14px");
});

test("only compact names clip, without removing the complete actor from the accessible DOM", () => {
  expect(body('.k2b-ui .k2b-activity[data-density="compact"] .k2b-activity__actor')).toContain("white-space: pre");
  expect(body('.k2b-ui .k2b-activity[data-density="compact"] .k2b-activity__actor-name')).toContain("text-overflow: ellipsis");
  expect(body(".k2b-ui .k2b-activity__text")).not.toContain("overflow: hidden");
});

test("neighbouring selected rows join into one surface without notches at the shared edge", () => {
  const lower = body(".k2b-ui .k2b-activity__entry[data-selected] + .k2b-activity__entry[data-selected]");
  const upper = body(".k2b-ui .k2b-activity__entry[data-selected]:has(+ .k2b-activity__entry[data-selected])");
  for (const corner of ["start-start", "start-end"]) expect(lower).toContain(`border-${corner}-radius: 0`);
  for (const corner of ["end-start", "end-end"]) expect(upper).toContain(`border-${corner}-radius: 0`);
});
