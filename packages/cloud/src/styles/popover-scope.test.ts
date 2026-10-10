import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("Cloud popover reset", () => {
  test("lets component-owned popover surfaces override the reset", async () => {
    const css = await Bun.file(resolve(import.meta.dir, "base-popover.css")).text();

    expect(css).toContain(":where([popover]:not(.paper)");
    expect(css).not.toMatch(/^\[popover\]:not\(.paper\)/m);
    const baseRule = css.match(/^\[popover\]\s*\{([^}]*)\}/m)?.[1] ?? "";
    expect(baseRule).not.toContain("transition");
    expect(css).not.toMatch(/^\[popover\]:popover-open\s*\{/m);
    expect(css).toContain(".tooltip-surface[popover] {");
    expect(css).toContain("display 0.12s allow-discrete");
  });

  test("places the portable UI scope on the shared HTML shell", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "../_internal/define-app.ts")).text();

    expect(source).toContain('<body class="k2b-ui" data-k2b-app-workspace-controller="global">');
  });
});
