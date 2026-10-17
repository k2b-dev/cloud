import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";
import type {} from "../../test/toolbar.browser-harness";

let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/toolbar.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "toolbar-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Toolbar harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async () => {
  const page = await browser.newPage();
  await page.setContent(
    `<!doctype html><html><head><style>${css}
      .k2b-ui .k2b-toolbar .hidden-group, .hidden-ancestor, body.hide-last #last {display:none}
    </style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector('#first[tabindex="0"]');
  return page;
};
const focused = (page: Page) => page.evaluate(() => document.activeElement?.id);
const stops = (page: Page) => page.locator('[aria-label="Horizontal"] [tabindex="0"]').count();

test("one tab stop enters at the first control and leaves in one Tab", async () => {
  const page = await open();
  try {
    expect(await stops(page)).toBe(1);
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("first");
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("after");
  } finally {
    await page.close();
  }
});

test("arrows wrap, Home/End jump, hidden and disabled controls are skipped", async () => {
  const page = await open();
  try {
    await page.locator("#first").focus();
    for (const [key, id] of [
      ["ArrowRight", "unavailable"],
      ["ArrowRight", "menu"],
      ["End", "last"],
      ["ArrowRight", "first"],
      ["ArrowLeft", "last"],
      ["Home", "first"],
    ]) {
      await page.keyboard.press(key!);
      expect(await focused(page)).toBe(id!);
      expect(await stops(page)).toBe(1);
    }
    await page.locator("#last").focus();
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("last");
  } finally {
    await page.close();
  }
});

test("open Dropdown menu keys keep their own focus", async () => {
  const page = await open();
  try {
    await page.locator("#menu").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("menuitem");
    expect(await stops(page)).toBe(1);
  } finally {
    await page.close();
  }
});

test("vertical and RTL orientations, modifiers and text-entry keys", async () => {
  const page = await open();
  try {
    await page.locator("#top").focus();
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("bottom");
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("top");
    await page.keyboard.press("ArrowUp");
    expect(await focused(page)).toBe("bottom");
    await page.keyboard.press("ArrowRight");
    expect(await focused(page)).toBe("bottom");
    await page.locator('[aria-label="Horizontal"]').evaluate((root) => {
      root.setAttribute("dir", "rtl");
    });
    await page.locator("#first").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await focused(page)).toBe("unavailable");
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await focused(page)).toBe("unavailable");
    for (const id of ["text", "textarea", "select", "editable"]) {
      await page.locator(`#${id}`).focus();
      await page.keyboard.press("ArrowRight");
      expect(await focused(page)).toBe(id);
    }
    await page.locator("#checkbox").focus();
    await page.keyboard.press("ArrowRight");
    expect(await focused(page)).toBe("field-last");
  } finally {
    await page.close();
  }
});

test("a toolbar mounted inside a hidden ancestor gains a tab stop when shown", async () => {
  const page = await open();
  try {
    const toolbar = page.locator('[aria-label="Initially hidden"]');
    expect(await toolbar.locator('[tabindex="0"]').count()).toBe(0);
    await page.locator("#hidden-ancestor").evaluate((ancestor) => ancestor.classList.remove("hidden-ancestor"));
    await page.waitForSelector('#revealed-first[tabindex="0"]');
    expect(await toolbar.locator('[tabindex="0"]').count()).toBe(1);
    await page.locator("#hidden-before").focus();
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("revealed-first");
  } finally {
    await page.close();
  }
});

test("an outside stylesheet hiding the tab stop chooses a visible control", async () => {
  const page = await open();
  try {
    await page.locator("#last").focus();
    expect(await page.locator("#last").getAttribute("tabindex")).toBe("0");
    await page.locator("body").evaluate((body) => body.classList.add("hide-last"));
    await page.waitForSelector('#first[tabindex="0"]');
    expect(await stops(page)).toBe(1);
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("first");
  } finally {
    await page.close();
  }
});

test("fields keep their own Tab stops and native value keys beside the roving group", async () => {
  const page = await open();
  try {
    await page.locator("#fields-before").focus();
    for (const id of ["field-first", "text", "textarea", "select", "editable", "range", "radio", "fields-after"]) {
      await page.keyboard.press("Tab");
      expect(await focused(page)).toBe(id);
      if (["text", "textarea", "select", "range", "radio"].includes(id))
        expect(await page.locator(`#${id}`).getAttribute("tabindex")).toBeNull();
      if (id === "editable") expect(await page.locator("#editable").getAttribute("tabindex")).toBe("0");
      if (id === "range") {
        for (const [key, value] of [
          ["ArrowRight", "6"],
          ["Home", "0"],
          ["End", "10"],
        ]) {
          await page.keyboard.press(key!);
          expect(await focused(page)).toBe("range");
          expect(await page.locator("#range").inputValue()).toBe(value!);
        }
      }
    }
    expect(
      await page.locator('[aria-label="Fields"] button[tabindex="0"], [aria-label="Fields"] input[type="checkbox"][tabindex="0"]').count(),
    ).toBe(1);
  } finally {
    await page.close();
  }
});

test("subtree mutations choose a remaining control when the tab stop disappears", async () => {
  const page = await open();
  try {
    await page.locator("#last").focus();
    await page.locator("#last").evaluate((button) => button.setAttribute("disabled", ""));
    await page.waitForSelector('#first[tabindex="0"]');
    await page.locator(".hidden-group").evaluate((group) => group.setAttribute("style", "display:flex"));
    await page.locator("#first").focus();
    await page.keyboard.press("ArrowRight");
    expect(await focused(page)).toBe("hidden");
    await page.locator("#hidden").evaluate((button) => button.remove());
    await page.waitForSelector('#first[tabindex="0"]');
    expect(await stops(page)).toBe(1);
  } finally {
    await page.close();
  }
});

// Include real icon glyph metrics in the hint geometry checks, without a server or network.
beforeAll(async () => {
  let icons = await Bun.file(resolve(import.meta.dir, "../../dist/tabler.css")).text();
  for (const match of icons.matchAll(/url\(([^)]+\.woff2[^)]*)\)/g)) {
    const font = await Bun.file(resolve(import.meta.dir, "../../dist", match[1]!.split("?")[0]!)).arrayBuffer();
    icons = icons.replace(match[0], `url(data:font/woff2;base64,${Buffer.from(font).toString("base64")})`);
  }
  css += `\n${icons}`;
});

const selectionOrder = ["Reply", "Forward", "Archive", "Later", "Move", "Delete", "Assistant", "Done"];
const removalOrder = ["Forward", "Delete", "Assistant", "Move", "Later", "Reply", "Archive"];
const selectionToolbar = (page: Page) => page.getByRole("toolbar", { name: "Selection actions" });
const movedLabels = (page: Page) =>
  selectionToolbar(page)
    .locator('.k2b-toolbar__action[data-overflow="hidden"]')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")!));
const openFloating = async (width = 575) => {
  const page = await open();
  await page.evaluate((width) => window.toolbarFixture.mount(width), width);
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  return page;
};
const resizeFloating = async (page: Page, width: number) => {
  await page.evaluate((width) => window.toolbarFixture.resize(width), width);
  // A ResizeObserver cycle decides the new layout; wait two frames before inspecting it.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
};

for (const [viewport, width] of [
  [{ width: 1194, height: 834 }, 575],
  [{ width: 834, height: 1194 }, 437],
  [{ width: 694, height: 834 }, 340],
] as const) {
  test(`floating actions fit a ${width}px column with ordered overflow and reserved row space`, async () => {
    const page = await open();
    try {
      await page.setViewportSize(viewport);
      await page.evaluate((width) => window.toolbarFixture.mount(width), width);
      const toolbar = selectionToolbar(page);
      const moved = await movedLabels(page);
      expect(new Set(moved)).toEqual(new Set(removalOrder.slice(0, moved.length)));
      const visible = await toolbar
        .locator(".k2b-toolbar__action:visible")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
      expect(visible).toEqual(selectionOrder.filter((label) => !moved.includes(label)));
      expect(await toolbar.locator(".k2b-toolbar__label").isVisible()).toBe(true);
      // Actions move before the selection count truncates.
      expect(await toolbar.locator(".k2b-toolbar__label").evaluate((label) => label.scrollWidth <= label.clientWidth)).toBe(true);
      expect(await toolbar.getByRole("button", { name: "Done", exact: true }).isVisible()).toBe(true);
      expect(
        await toolbar.evaluate((root) => {
          const children = Array.from(root.children).filter(
            (child) => child.getClientRects().length && !child.matches("[popover], .k2b-toolbar__spacer"),
          );
          const separators = children.map((child) => child.classList.contains("k2b-toolbar__separator"));
          return !separators[0] && !separators.at(-1) && separators.every((separator, index) => !separator || !separators[index + 1]);
        }),
      ).toBe(true);
      const pill = await toolbar.boundingBox();
      const column = await page.locator("#selection-column").boundingBox();
      expect(pill!.x + pill!.width).toBeLessThanOrEqual(column!.x + column!.width + 0.5);
      await page.locator("#selection-scroll").evaluate((scroll) => {
        scroll.scrollTop = scroll.scrollHeight;
      });
      const lastRow = await page.locator(".selection-row").last().boundingBox();
      const strip = await page.locator("#selection-column .k2b-toolbar-float").boundingBox();
      expect(lastRow!.y + lastRow!.height).toBeLessThanOrEqual(strip!.y + 0.5);
      const more = toolbar.getByRole("button", { name: "More actions", exact: true });
      expect(await more.isVisible()).toBe(moved.length > 0);
      if (moved.length) {
        await more.click();
        expect(await page.getByRole("menuitem").allTextContents()).toEqual(moved);
        await page.keyboard.press("Escape");
      }
      for (const button of await toolbar.locator("button:visible").all()) {
        const box = await button.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await page.close();
    }
  });
}

test("narrowing moves a superset of the least important actions and widening restores the original layout", async () => {
  const page = await openFloating();
  try {
    const wide = await movedLabels(page);
    await resizeFloating(page, 437);
    const middle = await movedLabels(page);
    await resizeFloating(page, 340);
    const narrow = await movedLabels(page);
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(wide.every((label) => middle.includes(label))).toBe(true);
    expect(middle.every((label) => narrow.includes(label))).toBe(true);
    for (const moved of [wide, middle, narrow]) expect(new Set(moved)).toEqual(new Set(removalOrder.slice(0, moved.length)));
    await resizeFloating(page, 575);
    expect(await movedLabels(page)).toEqual(wide);
    expect(await selectionToolbar(page).getByRole("button", { name: "More actions" }).isVisible()).toBe(wide.length > 0);
    expect(
      await selectionToolbar(page)
        .locator(".k2b-toolbar__action:visible")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ).toEqual(selectionOrder.filter((label) => !wide.includes(label)));
  } finally {
    await page.close();
  }
});

test("keyboard hints paint below stationary icons without changing any toolbar or button boxes", async () => {
  const page = await openFloating(340);
  try {
    const geometry = () =>
      selectionToolbar(page).evaluate((root) => {
        const box = (element: Element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        return { toolbar: box(root), buttons: Array.from(root.querySelectorAll("button")).map(box) };
      });
    const before = await geometry();
    const hints = selectionToolbar(page).locator(".k2b-toolbar__action:visible .k2b-toolbar__hint");
    expect(await hints.count()).toBeGreaterThan(0);
    for (const hint of await hints.all()) expect(await hint.evaluate((hint) => getComputedStyle(hint).visibility)).toBe("hidden");
    await page.evaluate(() => {
      document.documentElement.dataset.k2bKbd = "on";
    });
    expect(await geometry()).toEqual(before);
    for (const hint of await hints.all()) {
      expect(await hint.evaluate((hint) => getComputedStyle(hint).visibility)).toBe("visible");
      expect(
        await hint.evaluate((hint) => {
          const button = hint.closest("button")!.getBoundingClientRect();
          const icon = hint.closest("button")!.querySelector("i")!.getBoundingClientRect();
          const box = hint.getBoundingClientRect();
          return box.top >= icon.bottom && box.bottom <= button.bottom && box.left >= button.left && box.right <= button.right;
        }),
      ).toBe(true);
    }
  } finally {
    await page.close();
  }
});

test("the synchronous mount decides overflow before yielding, while hidden ancestors keep it pending", async () => {
  const page = await open();
  try {
    const snapshot = await page.evaluate(() => {
      window.toolbarFixture.mount(340);
      const root = document.querySelector('[aria-label="Selection actions"]')!;
      return {
        pending: root.hasAttribute("data-overflow-pending"),
        moved: root.querySelectorAll('.k2b-toolbar__action[data-overflow="hidden"]').length,
      };
    });
    expect(snapshot.pending).toBe(false);
    expect(snapshot.moved).toBeGreaterThan(0);
    const hidden = await page.evaluate(() => {
      window.toolbarFixture.mount(340, true);
      return document.querySelector('[aria-label="Selection actions"]')!.hasAttribute("data-overflow-pending");
    });
    expect(hidden).toBe(true);
    await page.evaluate(() => window.toolbarFixture.show());
    await page.waitForFunction(() => !document.querySelector('[aria-label="Selection actions"]')!.hasAttribute("data-overflow-pending"));
    expect((await movedLabels(page)).length).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});

test("floating More participates in roving focus, restores focus on Escape, and runs moved actions", async () => {
  const page = await openFloating(340);
  try {
    const toolbar = selectionToolbar(page);
    const moved = await movedLabels(page);
    expect(moved.length).toBeGreaterThan(0);
    const more = toolbar.getByRole("button", { name: "More actions", exact: true });
    // The focusable message list comes right before the toolbar.
    await page.locator("#selection-scroll").focus();
    await page.keyboard.press("Tab");
    expect(await toolbar.evaluate((root) => root.contains(document.activeElement))).toBe(true);
    expect(await toolbar.locator('button[tabindex="0"]').count()).toBe(1);
    const visited: (string | null)[] = [];
    const visibleCount = await toolbar.locator("button:visible").count();
    for (let index = 0; index < visibleCount; index++) {
      visited.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null));
      await page.keyboard.press("ArrowRight");
    }
    expect(visited).toContain("More actions");
    expect(visited.some((name) => name && moved.includes(name))).toBe(false);
    await page.keyboard.press("End");
    expect(await more.evaluate((button) => button === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
    await page.keyboard.press("Escape");
    expect(await more.evaluate((button) => button === document.activeElement)).toBe(true);
    expect(await page.getByRole("menu").count()).toBe(0);
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: moved[0]!, exact: true }).click();
    expect(await page.evaluate(() => window.toolbarFixture.clicked)).toEqual([moved[0]!]);
    expect(await toolbar.locator('button[tabindex="0"]').count()).toBe(1);
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("floating-after");
  } finally {
    await page.close();
  }
});

test("Toolbar.Action keeps the plain accessible label and ARIA shortcut while its tooltip names the shortcut", async () => {
  const page = await openFloating();
  try {
    const archive = selectionToolbar(page).getByRole("button", { name: "Archive", exact: true });
    expect(await archive.getAttribute("aria-label")).toBe("Archive");
    expect(await archive.getAttribute("aria-keyshortcuts")).toBe("E");
    await archive.hover();
    await page.getByRole("tooltip", { name: "Archive (E)", exact: true }).waitFor();
    await resizeFloating(page, 340);
    expect(await selectionToolbar(page).getByRole("button", { name: "More actions", exact: true }).isVisible()).toBe(true);
  } finally {
    await page.close();
  }
});

test("moving the focused action transfers focus to More and repairs its tab stop", async () => {
  const page = await openFloating();
  try {
    await selectionToolbar(page).getByRole("button", { name: "Forward", exact: true }).focus();
    await resizeFloating(page, 340);
    expect(
      await selectionToolbar(page)
        .getByRole("button", { name: "More actions", exact: true })
        .evaluate((button) => button === document.activeElement),
    ).toBe(true);
    expect(await selectionToolbar(page).locator('button[tabindex="0"]').count()).toBe(1);
  } finally {
    await page.close();
  }
});

test("inline toolbars keep every prioritised action in place and render no More menu", async () => {
  const page = await open();
  try {
    await page.evaluate(() => window.toolbarFixture.mount(340, false, { variant: "inline" }));
    const toolbar = selectionToolbar(page);
    expect(await movedLabels(page)).toEqual([]);
    expect(await toolbar.getByRole("button", { name: "More actions", includeHidden: true }).count()).toBe(0);
    expect(await toolbar.getAttribute("data-overflow-pending")).toBeNull();
    expect(
      await toolbar.locator(".k2b-toolbar__action").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ).toEqual(selectionOrder);
  } finally {
    await page.close();
  }
});

test("priority ties follow current DOM order, and registration cleanup removes stale menu rows", async () => {
  const page = await openFloating(340);
  try {
    await page.evaluate(() => {
      for (const label of ["Reply", "Forward", "Archive", "Later", "Move", "Delete", "Assistant"]) {
        window.toolbarFixture.override(label, { priority: 1 });
      }
    });
    const tied = await movedLabels(page);
    expect(tied.length).toBeGreaterThan(0);
    expect(tied).toEqual(selectionOrder.slice(0, -1).slice(-tied.length));
    // Move an earlier-registered control to the end: registration order must not choose the menu order.
    await selectionToolbar(page).evaluate((root) => {
      const reply = root.querySelector('[aria-label="Reply"]')!;
      root.insertBefore(reply, root.querySelector(".k2b-toolbar__more"));
    });
    await page.waitForFunction(() => document.querySelector('[aria-label="Reply"]')?.hasAttribute("data-overflow"));
    const reordered = await movedLabels(page);
    const order = ["Forward", "Archive", "Later", "Move", "Delete", "Assistant", "Reply"];
    expect(reordered).toEqual(order.slice(-reordered.length));
    await selectionToolbar(page).getByRole("button", { name: "More actions" }).click();
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(reordered);
    await page.keyboard.press("Escape");
    // Remount disposes the registry and its observers; the fresh menu contains only the new actions.
    await page.evaluate(() => window.toolbarFixture.mount(340));
    const fresh = await movedLabels(page);
    expect(new Set(fresh)).toEqual(new Set(removalOrder.slice(0, fresh.length)));
    await selectionToolbar(page).getByRole("button", { name: "More actions" }).click();
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(fresh);
  } finally {
    await page.close();
  }
});

test("moved rows retain reactive names, icons, disabled state, and handlers", async () => {
  const page = await openFloating(340);
  try {
    await page.evaluate(() => {
      window.toolbarFixture.override("Forward", {
        label: "Redirect",
        icon: "ti ti-send",
        onClick: () => window.toolbarFixture.clicked.push("updated"),
      });
      window.toolbarFixture.override("Delete", { disabled: true });
    });
    const toolbar = selectionToolbar(page);
    await toolbar.getByRole("button", { name: "More actions" }).click();
    expect(await page.getByRole("menuitem", { name: "Delete", exact: true }).getAttribute("aria-disabled")).toBe("true");
    expect(await page.getByRole("menuitem", { name: "Redirect", exact: true }).locator("i.ti-send").count()).toBe(1);
    await page.getByRole("menuitem", { name: "Redirect", exact: true }).click();
    expect(await page.evaluate(() => window.toolbarFixture.clicked)).toEqual(["updated"]);
    // Reprioritising an action remeasures it even when the column width stays the same.
    await page.evaluate(() => window.toolbarFixture.override("Archive", { priority: 99 }));
    expect(await movedLabels(page)).toContain("Archive");
  } finally {
    await page.close();
  }
});

test("empty groups and redundant separators disappear, including beside a spacer", async () => {
  const page = await openFloating(340);
  try {
    await page.evaluate(() => {
      window.toolbarFixture.override("Reply", { priority: 99 });
      window.toolbarFixture.override("Forward", { priority: 99 });
    });
    const toolbar = selectionToolbar(page);
    expect(await toolbar.getByRole("group", { name: "Respond", includeHidden: true }).getAttribute("data-overflow")).toBe("hidden");
    await toolbar.evaluate((root) => {
      const separator = root.querySelector(".k2b-toolbar__separator")!;
      const leading = separator.cloneNode();
      root.prepend(leading);
      root.append(separator.cloneNode(), separator.cloneNode());
      const spacer = document.createElement("span");
      spacer.className = "k2b-toolbar__spacer";
      root.prepend(spacer);
    });
    await page.waitForFunction(() => {
      const children = Array.from(document.querySelector('[aria-label="Selection actions"]')!.children).filter(
        (child) => child.getClientRects().length && !child.matches("[popover], .k2b-toolbar__spacer"),
      );
      const separators = children.map((child) => child.matches(".k2b-toolbar__separator"));
      return !separators[0] && !separators.at(-1) && separators.every((value, index) => !value || !separators[index + 1]);
    });
  } finally {
    await page.close();
  }
});
