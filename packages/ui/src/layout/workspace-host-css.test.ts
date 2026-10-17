import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(import.meta.dir, "../styles/layout-parity.css"), "utf8");
const source = readFileSync(resolve(import.meta.dir, "AppWorkspace.tsx"), "utf8");

test("waiting-detail fit thresholds keep Main's 20rem, each width token, and the 0.5rem inset", () => {
  const tokens = source.match(/const widths = \{ sm: (\d+), md: (\d+), lg: (\d+), xl: (\d+) \}/);
  expect(tokens).not.toBeNull();
  for (const [index, token] of ["sm", "md", "lg", "xl"].entries()) {
    const threshold = 20 + Number(tokens![index + 1]) / 16 + 0.5;
    expect(css).toContain(`@container k2b-workspace (width < ${threshold}rem)`);
    const rule = css.match(new RegExp(`\\.k2b-app-workspace:has\\([^{}]*\\[data-width="${token}"\\][^{}]*\\)\\s*\\{([^}]*)\\}`))?.[1];
    expect(rule).toContain(`--k2b-workspace-detail-fit: ${threshold}rem;`);
  }
  expect(css).toContain("--k2b-workspace-detail-inset: 0.5rem");
});
