import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-choice-list-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { ChoiceList } = await import("./ChoiceList");

describe("ChoiceList", () => {
  const options = [
    { value: "all", label: "All messages", description: "Every new message.", marker: "Default" },
    { value: "mentions", label: "Mentions only", description: "Only when someone mentions you." },
    { value: "off", label: "Off" },
  ];

  test("renders a labeled radio group whose chosen row holds the tab stop and names its sentence", () => {
    const html = renderToString(() =>
      createComponent(ChoiceList, { id: "level", label: "Notifications", description: "Per chat", value: "mentions", options }),
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-labelledby="level-label"');
    expect(html).toContain('aria-describedby="level-description"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*>.*Mentions only/s);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('aria-describedby="level-option-0"');
    expect(html).toContain('id="level-option-1"');
    expect(html.match(/k2b-choice-list__description/g)).toHaveLength(2);
    expect(html).toContain('<span class="k2b-choice-list__marker">Default</span>');
    expect(html).not.toContain("aria-busy");
    // Every row keeps the spinner's place, so a save starting or ending moves nothing.
    expect(html.match(/k2b-choice-list__busy/g)).toHaveLength(3);
    expect(html).not.toContain("k2b-spin");
  });

  test("without a chosen value the first row holds the tab stop", () => {
    const html = renderToString(() => createComponent(ChoiceList, { "aria-label": "Level", value: null, options }));
    expect(html).toContain('aria-label="Level"');
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toMatch(/tabindex="0"[^>]*>.*All messages/s);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });

  test("a save in progress shows its spinner beside the chosen row only, and details open under it", () => {
    const html = renderToString(() =>
      createComponent(ChoiceList, {
        "aria-label": "Level",
        value: "off",
        options,
        busy: true,
        busyLabel: "Saving",
        details: "For 8 hours",
      }),
    );
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/k2b-spin/g)).toHaveLength(1);
    expect(html).toMatch(/aria-checked="true".*Off.*aria-label="Saving".*k2b-choice-list__details.*For 8 hours/s);
    expect(html.match(/k2b-choice-list__details/g)).toHaveLength(1);
  });

  test("a disabled list disables every row", () => {
    const html = renderToString(() => createComponent(ChoiceList, { "aria-label": "Level", value: "all", options, disabled: true }));
    expect(html).toContain('aria-disabled="true"');
    expect(html.match(/<button[^>]* disabled[ >]/g)).toHaveLength(3);
  });
});
