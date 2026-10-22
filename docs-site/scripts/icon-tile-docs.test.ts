import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Icon tile documentation matches the shared CSS rule and theme fill values", () => {
  const css = readFileSync(new URL("../../packages/ui/src/styles/index.css", import.meta.url), "utf8");
  const docs = readFileSync(new URL("../src/ui/context/surfaces/utilities.md", import.meta.url), "utf8");
  const section = docs.split(/^## Icon tile\r?\n/m)[1]?.split(/^## /m)[0];
  expect(section).toBeDefined();
  for (const name of ["k2b-icon-tile", "currentColor", "--k2b-icon-tile-fill"]) expect(section).toContain(`\`${name}\``);

  const rule = css.match(/\.k2b-ui \.k2b-icon-tile\s*\{([^}]+)\}/)?.[1];
  const radius = rule?.match(/border-radius:\s*(\d+(?:\.\d+)?%)/)?.[1];
  expect(radius).toBeDefined();
  expect(section).toContain(`radius is ${radius}`);
  expect(rule).toContain("color-mix(in srgb, currentColor var(--k2b-icon-tile-fill), transparent)");

  const scopes = [
    ["light", /^\.k2b-ui\s*\{([^}]+)\}/m],
    ["dark", /^\.k2b-ui\[data-theme="dark"\][^{]*\{([^}]+)\}/m],
  ] as const;
  const fills = scopes.map(([theme, selector]) => {
    const scope = css.match(selector)?.[1];
    const value = scope?.match(/--k2b-icon-tile-fill:\s*(\d+(?:\.\d+)?%)/)?.[1];
    expect(value, theme).toBeDefined();
    expect(section).toContain(`${value} ${theme}`);
    return value!;
  });
  expect([...(section!.match(/\d+(?:\.\d+)?%/g) ?? [])]).toEqual([...fills, radius!]);
});
