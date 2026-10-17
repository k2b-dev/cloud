import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { dropdownPosition } from "@k2b/ui";
import {
  attach,
  cardInset,
  cardRadius,
  desktop,
  devices,
  html,
  installCompactShellHarness,
  ipadLandscape,
  ipadPortrait,
  ipadSplitView,
  laptop,
  open,
  phone,
  smallLaptop,
  tabletBoundary,
  type Device,
} from "./compact-shell.browser-harness";

installCompactShellHarness();

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Geometry = {
  header: string | null;
  rail: { display: string; box: Box; borders: number[] } | null;
  shell: { box: Box; borders: number[]; background: string } | null;
  workspace: { box: Box; borders: number[]; radius: string; shadow: string } | null;
  bar: { display: string; box: Box; borders: number[]; title: string } | null;
  sidebar: { visibility: string; display: string; box: Box; borders: number[] } | null;
  pane: { box: Box; borders: number[] } | null;
  main: { box: Box; borders: number[] } | null;
  detail: { box: Box; borders: number[] } | null;
  avatar: { box: Box; visible: boolean } | null;
  hairlines: string[];
};

const geometry = (page: Page, rounded = true): Promise<Geometry> =>
  page.evaluate((rounded) => {
    const coordinate = (value: number) => (rounded ? Math.round(value) : value);
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return {
        left: coordinate(rect.left),
        top: coordinate(rect.top),
        right: coordinate(rect.right),
        bottom: coordinate(rect.bottom),
        width: coordinate(rect.width),
        height: coordinate(rect.height),
      };
    };
    const borders = (element: Element) => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map((value) =>
        Number.parseFloat(value),
      );
    };
    const find = (selector: string) => document.querySelector(selector);
    const header = find(".layout-header");
    const rail = find(".layout-rail");
    const shell = find(".layout-shell-content");
    const workspace = find(".k2b-app-workspace");
    const bar = find(".k2b-app-workspace__head");
    const title = find(".k2b-app-workspace__head .k2b-page-title__text");
    const sidebar = find(".k2b-app-workspace__sidebar");
    const pane = find(".k2b-app-workspace__main-pane");
    const main = find(".k2b-app-workspace__main");
    const detail = find(".k2b-app-workspace__detail");
    const avatar = [...document.querySelectorAll(".layout-profile-preferences > :is(button, .layout-profile-preferences__dropdown)")].find(
      (element) => getComputedStyle(element).display !== "none",
    );
    // A divider element: a visible box at most 2 px thin that spans a large part of the app area.
    const appWidth = shell?.getBoundingClientRect().width ?? window.innerWidth;
    const hairlines = [...document.querySelectorAll(".cloud-app-canvas *")].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return [];
      const vertical = rect.width > 0 && rect.width <= 2 && rect.height >= window.innerHeight / 2;
      const horizontal = rect.height > 0 && rect.height <= 2 && rect.width >= appWidth / 2;
      return vertical || horizontal ? [element.className.toString() || element.localName] : [];
    });
    return {
      header: header ? getComputedStyle(header).display : null,
      rail: rail ? { display: getComputedStyle(rail).display, box: box(rail), borders: borders(rail) } : null,
      shell: shell ? { box: box(shell), borders: borders(shell), background: getComputedStyle(shell).backgroundColor } : null,
      workspace: workspace
        ? {
            box: box(workspace),
            borders: borders(workspace),
            radius: getComputedStyle(workspace).borderTopRightRadius,
            shadow: getComputedStyle(workspace).boxShadow,
          }
        : null,
      bar: bar
        ? {
            display: getComputedStyle(bar).display,
            box: box(bar),
            borders: borders(bar),
            title: title?.textContent ?? "",
          }
        : null,
      sidebar: sidebar
        ? {
            visibility: getComputedStyle(sidebar).visibility,
            display: getComputedStyle(sidebar).display,
            box: box(sidebar),
            borders: borders(sidebar),
          }
        : null,
      pane: pane ? { box: box(pane), borders: borders(pane) } : null,
      main: main ? { box: box(main), borders: borders(main) } : null,
      detail: detail ? { box: box(detail), borders: borders(detail) } : null,
      avatar: avatar ? { box: box(avatar), visible: true } : null,
      hairlines,
    };
  }, rounded);

const none = [0, 0, 0, 0];
const tablet = (device: Device) => device.width >= 768 && device.width < 1024;
const compact = (device: Device) => device.width >= 768 && device.width < 1024;

describe("signed-in shell", () => {
  for (const device of devices) {
    for (const theme of ["light", "dark"] as const) {
      test(`${device.name} ${device.width}×${device.height} ${theme}: chrome, app edges, and lines`, async () => {
        const { context, page } = await open(device, "/app/mail/inbox", { theme });
        try {
          const shape = await geometry(page);
          if (device.width < 768) {
            // Phones keep the title row above a soft content card and floating navigation.
            expect(shape.header).not.toBe("none");
            expect(shape.rail?.display).toBe("none");
            expect(shape.bar?.display).toBe("none");
            expect(shape.sidebar?.display).toBe("none");
            expect(shape.workspace?.borders).toEqual(none);
            expect(shape.workspace?.radius).toBe("0px");
            const soft = await page.locator(".layout-content-main").evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
                overflow: style.overflowY,
              };
            });
            expect(soft.radii).toEqual(["28px", "28px", "0px", "0px"]);
            expect(["auto", "scroll"]).toContain(soft.overflow);
            expect(await page.locator(".layout-header").evaluate((element) => getComputedStyle(element).borderBottomWidth)).toBe("0px");
            expect(await page.locator(".cloud-app-canvas").evaluate((element) => getComputedStyle(element).backgroundImage)).toContain(
              "gradient",
            );
            expect(await page.locator(".cloud-tab-bar .k2b-tab-bar").isVisible()).toBe(true);
            return;
          }
          expect(shape.header).toBe("none");
          expect(shape.rail?.display).toBe("flex");
          expect(shape.rail?.box.left).toBe(tablet(device) ? 8 : 0);
          expect(shape.rail?.box.width).toBe(tablet(device) ? 60 : 56);
          expect(shape.rail?.box.right).toBe(tablet(device) ? 68 : 56);
          // Nothing draws the rail/app boundary: no border on either side and no divider element.
          expect(shape.rail?.borders).toEqual(none);
          expect(shape.shell?.borders).toEqual(none);
          expect(shape.hairlines).toEqual([]);
          // The avatar is the rail's last control.
          expect(shape.avatar).not.toBeNull();
          expect(shape.avatar!.box.left).toBeGreaterThanOrEqual(0);
          expect(shape.avatar!.box.right).toBeLessThanOrEqual(shape.rail!.box.right);
          expect(shape.rail!.box.bottom - shape.avatar!.box.bottom).toBeLessThanOrEqual(12);
          if (tablet(device)) {
            expect(shape.shell?.box).toMatchObject({ left: 76, top: 8, right: device.width - 8, bottom: device.height - 8 });
            expect(shape.rail?.box).toMatchObject({ top: 8, bottom: device.height - 8 });
            expect(shape.workspace?.box).toMatchObject({ left: 76, top: 8, right: device.width - 8, bottom: device.height - 8 });
            expect(shape.workspace?.radius).toBe("20px");
            expect(shape.workspace?.borders).toEqual([1, 1, 1, 1]);
            expect(shape.workspace?.shadow).not.toBe("none");
            const rail = await page.locator(".layout-rail").evaluate((element) => ({
              radius: getComputedStyle(element).borderRadius,
              image: getComputedStyle(element).backgroundImage,
            }));
            expect(rail.radius).toBe("20px");
            expect(rail.image).toContain("gradient");
          } else {
            // From 1024 px the card's spacing and radius grow until 1440 px.
            const precise = await geometry(page, false);
            const box = precise.workspace!.box;
            const gaps = [box.top, device.width - box.right, device.height - box.bottom];
            const radius = Number.parseFloat(precise.workspace!.radius);
            expect(box.left).toBe(56);
            for (const gap of gaps) expect(Math.abs(gap - cardInset(device.width))).toBeLessThanOrEqual(0.5);
            expect(Math.abs(radius - cardRadius(device.width))).toBeLessThanOrEqual(0.05);
            if (device.width === 1024) {
              for (const gap of gaps) expect(gap).toBe(4);
              expect(radius).toBe(10);
            } else if (device.width >= 1440) {
              for (const gap of gaps) expect(gap).toBe(8);
              expect(radius).toBe(14);
            } else if (device.width === 1194) {
              // The dense tablet mockup's card: 6 px spacing and a 12 px radius.
              for (const gap of gaps) expect(gap).toBe(6);
              expect(radius).toBe(12);
            }
            expect(shape.workspace?.shadow).not.toBe("none");
          }
          // Sidebar and Main draw no lines. List/reader panes keep their
          // separator; the raised detail floats without one.
          expect(shape.sidebar?.borders).toEqual(none);
          expect(shape.main?.borders).toEqual(none);
          expect(shape.pane?.borders).toEqual([0, 1, 0, 0]);
          expect(shape.detail?.borders).toEqual([0, 0, 0, 0]);
          // List and reader stay side by side; the detail spans the workspace.
          expect(shape.pane!.box.right).toBeLessThanOrEqual(shape.detail!.box.left);
          expect(shape.detail!.box.top).toBe(shape.workspace!.box.top + shape.workspace!.borders[0]! + 8);
          if (compact(device)) {
            expect(shape.bar?.display).toBe("flex");
            expect(shape.bar?.borders).toEqual(none);
            // The 320 px detail and its 8 px right inset still reserve a 328 px track.
            expect(shape.detail!.box.width).toBe(320);
            expect(shape.bar?.box).toMatchObject({ left: 77, top: 9, right: device.width - 8 - 1 - (320 + 8), height: 46 });
            expect(shape.bar?.title).toBe("Inbox");
            expect(shape.sidebar?.visibility).toBe("hidden");
            expect(shape.pane!.box.top).toBe(55);
          } else {
            expect(shape.bar?.display).toBe("none");
            expect(shape.sidebar?.visibility).toBe("visible");
            expect(shape.sidebar!.box.right).toBeLessThanOrEqual(shape.pane!.box.left);
          }
        } finally {
          await context.close();
        }
      });
    }
  }

  test("a notice above the app is a card with shell spacing from 768 px", async () => {
    for (const device of [ipadPortrait, tabletBoundary, ipadLandscape]) {
      const { context, page } = await open(device, "/app/mail/inbox?notice=1");
      try {
        const notice = await page.evaluate(() => {
          const card = document.querySelector(".layout-shell-content .k2b-notice-card")!;
          const style = getComputedStyle(card);
          const rect = card.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            radius: style.borderTopLeftRadius,
            border: style.borderTopWidth,
          };
        });
        expect(notice.left).toBe(tablet(device) ? 76 : 56);
        if (tablet(device)) {
          expect(notice).toMatchObject({ left: 76, right: device.width - 8, top: 8, border: "1px" });
          expect(Number.parseFloat(notice.radius)).toBeGreaterThan(0);
          const gap = await page.evaluate(
            () =>
              document.querySelector(".layout-content-main")!.getBoundingClientRect().top -
              document.querySelector(".k2b-notice-card")!.getBoundingClientRect().bottom,
          );
          expect(gap).toBe(8);
        } else {
          expect(Math.abs(notice.top - cardInset(device.width))).toBeLessThanOrEqual(0.5);
          expect(Math.abs(device.width - notice.right - cardInset(device.width))).toBeLessThanOrEqual(0.5);
          expect(Number.parseFloat(notice.radius)).toBeGreaterThan(0);
          expect(notice.border).toBe("1px");
        }
      } finally {
        await context.close();
      }
    }
  });

  test("neither the controller attaching nor navigating to another page moves any part of the shell", async () => {
    const keys = ["rail", "shell", "workspace", "bar", "sidebar", "pane", "main", "detail", "avatar"] as const;
    const same = (device: Device, step: string, actual: Geometry, expected: Geometry) => {
      for (const key of keys) {
        const box = actual[key]?.box;
        const reference = expected[key]?.box;
        expect({ device: device.name, step, key, present: !!box }).toEqual({ device: device.name, step, key, present: !!reference });
        if (box && reference) {
          for (const edge of ["left", "top", "right", "bottom", "width", "height"] as const)
            expect(Math.abs(box[edge] - reference[edge]), `${device.name} ${step} ${key}.${edge}`).toBeLessThanOrEqual(0.01);
        }
      }
    };
    const noOverflow = async (page: Page) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    for (const device of devices) {
      const { context, page } = await open(device, "/app/mail/inbox", { attached: false });
      try {
        const served = await geometry(page, false);
        await noOverflow(page);
        await attach(page);
        same(device, "attach", await geometry(page, false), served);
        await noOverflow(page);
        // Reload the same server path and attach again, without relying on a live HTTP server.
        await page.setContent(await html("/app/mail/inbox"));
        same(device, "reload served", await geometry(page, false), served);
        await attach(page);
        same(device, "reload attached", await geometry(page, false), served);
        await noOverflow(page);
        await page.setContent(await html("/app/mail/archive"));
        await attach(page);
        same(device, "navigate", await geometry(page, false), served);
        await noOverflow(page);
      } finally {
        await context.close();
      }
    }
  });

  for (const device of [ipadPortrait, smallLaptop, ipadLandscape, laptop, desktop]) {
    test(`${device.name}: a page without a workspace follows the card rule`, async () => {
      const { context, page } = await open(device, "/app/mail/inbox?cards=1");
      try {
        const shape = await geometry(page, false);
        expect(shape.workspace).toBeNull();
        expect(shape.shell!.box.left).toBe(tablet(device) ? 76 : 56);
        if (tablet(device)) {
          expect(shape.shell!.box).toMatchObject({ top: 8, right: device.width - 8, bottom: device.height - 8 });
          expect(shape.shell!.background).toBe("rgba(0, 0, 0, 0)");
        } else {
          const box = shape.shell!.box;
          for (const gap of [box.top, device.width - box.right, device.height - box.bottom])
            expect(Math.abs(gap - cardInset(device.width))).toBeLessThanOrEqual(0.5);
          expect(shape.shell!.background).toBe("rgba(0, 0, 0, 0)");
        }
      } finally {
        await context.close();
      }
    });
  }

  for (const device of [{ name: "rail boundary", width: 768, height: 1024, touch: true }, ipadPortrait, ipadLandscape, laptop, desktop]) {
    test(`${device.width}×${device.height}: rail controls are 44 px targets inside the responsive rail`, async () => {
      const { context, page } = await open(device, "/app/mail/inbox");
      try {
        const controls = await page.evaluate(() => {
          const rail = document.querySelector(".layout-rail")!.getBoundingClientRect();
          const items = [...document.querySelectorAll(".layout-rail .rail-item")].filter((item) => item.checkVisibility());
          const avatar = [
            ...document.querySelectorAll(
              ".layout-rail .layout-profile-preferences__link, .layout-rail .layout-profile-preferences__dropdown-trigger",
            ),
          ].find((item) => item.checkVisibility())!;
          const box = (element: Element) => {
            const { left, right, width, height } = element.getBoundingClientRect();
            return { left, right, width, height };
          };
          return {
            rail: { left: rail.left, right: rail.right },
            items: items.map(box),
            avatar: box(avatar),
            // The apps, the app grid, search, and help draw a 20 px icon; the avatar is 32 px.
            icons: items.map((item) => getComputedStyle(item.querySelector("i")!).fontSize),
            avatarSize: avatar.querySelector(".k2b-avatar")!.getBoundingClientRect().width,
          };
        });
        expect(controls.rail).toEqual(tablet(device) ? { left: 8, right: 68 } : { left: 0, right: 56 });
        expect(controls.items.length).toBeGreaterThanOrEqual(4);
        expect(controls.icons).toEqual(controls.items.map(() => "20px"));
        expect(controls.avatarSize).toBe(32);
        for (const box of [...controls.items, controls.avatar]) {
          expect(box.width).toBe(44);
          expect(box.height).toBe(44);
          expect(box.left).toBeGreaterThanOrEqual(controls.rail.left);
          expect(box.right).toBeLessThanOrEqual(controls.rail.right);
        }
      } finally {
        await context.close();
      }
    });
  }
});

describe("the app card keeps its rounded corners", () => {
  const pages = [
    { name: "framed workspace", path: "/app/mail/inbox?list=scroll" },
    { name: "flat overview", path: "/app/mail/inbox?overview=1" },
  ];
  type CardGeometry = {
    box: Box;
    railRight: number | null;
    radii: string[];
    expectedRadius: string;
    shellSpacing: number;
    shadow: string;
    workspaceScroll: { top: number; end: number };
    pageScroll: { height: number; clientHeight: number; width: number; clientWidth: number };
  };
  const cardGeometry = (page: Page): Promise<CardGeometry> =>
    page.evaluate(async () => {
      const workspace = document.querySelector<HTMLElement>(".layout-content-main .k2b-app-workspace")!;
      const main = workspace.querySelector<HTMLElement>(".k2b-app-workspace__main")!;
      const pageMain = document.querySelector<HTMLElement>(".layout-content-main")!;
      // Resolve the host's tokens on the workspace, including var() and rem values.
      const probe = document.createElement("span");
      const signedIn = !!workspace.closest("[data-layout-authenticated]");
      probe.style.cssText = signedIn
        ? "position:absolute;pointer-events:none;width:var(--cloud-card-inset);border-radius:var(--cloud-card-radius)"
        : "position:absolute;pointer-events:none;width:var(--ui-space-shell);border-radius:var(--k2b-radius-dialog)";
      workspace.append(probe);
      const expectedRadius = getComputedStyle(probe).borderTopLeftRadius;
      const shellSpacing = Number.parseFloat(getComputedStyle(probe).width);
      probe.remove();
      const rect = workspace.getBoundingClientRect();
      const style = getComputedStyle(workspace);
      // The corners are sampled with the content scrolled to its end, not on the first rows.
      main.scrollTop = main.scrollHeight;
      await new Promise<void>((settle) => requestAnimationFrame(() => settle()));
      return {
        box: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        railRight: document.querySelector(".layout-rail")?.getBoundingClientRect().right ?? null,
        radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
        expectedRadius,
        shellSpacing,
        shadow: style.boxShadow,
        workspaceScroll: { top: main.scrollTop, end: main.scrollHeight - main.clientHeight },
        pageScroll: {
          height: pageMain.scrollHeight,
          clientHeight: pageMain.clientHeight,
          width: pageMain.scrollWidth,
          clientWidth: pageMain.clientWidth,
        },
      };
    });

  /**
   * Reads what the engine painted at the card's corners. Every part of the workspace and its text is
   * filled red first, so a part that reaches past the rounded corner shows in the pixel one step inside
   * the box's corner, which lies outside the card. Hit testing cannot tell this: WebKit ignores a
   * rounded clip there.
   */
  const cornerPaint = async (page: Page, box: Box) => {
    await page.addStyleTag({
      content:
        ".layout-content-main .k2b-app-workspace, .layout-content-main .k2b-app-workspace * { background: rgb(255 0 0) !important; color: rgb(255 0 0) !important; }",
    });
    const corners = [
      { corner: "top left", x: box.left, y: box.top, dx: 1, dy: 1 },
      { corner: "top right", x: box.right - 1, y: box.top, dx: -1, dy: 1 },
      { corner: "bottom right", x: box.right - 1, y: box.bottom - 1, dx: -1, dy: -1 },
      { corner: "bottom left", x: box.left, y: box.bottom - 1, dx: 1, dy: -1 },
    ];
    const shot = (await page.screenshot()).toString("base64");
    return page.evaluate(
      async ({ shot, corners }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${shot}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const filled = (x: number, y: number) => {
          const [red, green, blue] = context.getImageData(x, y, 1, 1).data;
          return red! > 200 && green! < 60 && blue! < 60;
        };
        return corners.map(({ corner, x, y, dx, dy }) => ({
          corner,
          outside: filled(x + dx, y + dy),
          inside: filled(x + 48 * dx, y + 48 * dy),
        }));
      },
      { shot, corners },
    );
  };

  /** Reads the RGB values the engine painted at the given viewport points. */
  const pixels = async (page: Page, points: { x: number; y: number }[]) => {
    const shot = (await page.screenshot()).toString("base64");
    return page.evaluate(
      async ({ shot, points }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${shot}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return points.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3));
      },
      { shot, points },
    );
  };
  /** The largest channel difference between two pixel lists of the same points. */
  const difference = (a: number[][], b: number[][]) =>
    Math.max(...a.flatMap((pixel, index) => pixel.map((channel, rgb) => Math.abs(channel - b[index]![rgb]!))));

  /**
   * Reads what the engine painted in the shell spacing below the middle of the card's bottom edge, once
   * as served and once with the card's shadow removed. A computed `box-shadow` alone cannot tell whether
   * a scrolling ancestor clips the shadow away.
   */
  const shadowPaint = async (page: Page, box: Box, shellSpacing: number) => {
    const x = Math.round((box.left + box.right) / 2);
    const points = Array.from({ length: Math.max(1, Math.floor(shellSpacing) - 2) }, (_, step) => ({ x, y: box.bottom + 1 + step }));
    const painted = await pixels(page, points);
    const unshadowed = await page.addStyleTag({ content: ".layout-content-main .k2b-app-workspace { box-shadow: none !important; }" });
    const bare = await pixels(page, points);
    await unshadowed.evaluate((tag) => tag.parentNode?.removeChild(tag));
    return { painted, shadowDepth: difference(painted, bare) };
  };

  /**
   * Reads the paint one step inside each corner of the card's box, outside its rounded edge, once as
   * served and once with everything inside the card hidden. Unlike `cornerPaint`, it also sees paint the
   * red fill cannot reach, such as a shadow or a scrollbar of a part inside the card.
   */
  const cornerLeak = async (page: Page, box: Box) => {
    const points = [
      { x: box.left + 1, y: box.top + 1 },
      { x: box.right - 2, y: box.top + 1 },
      { x: box.right - 2, y: box.bottom - 2 },
      { x: box.left + 1, y: box.bottom - 2 },
    ];
    const served = await pixels(page, points);
    const emptied = await page.addStyleTag({ content: ".layout-content-main .k2b-app-workspace > * { opacity: 0 !important; }" });
    const empty = await pixels(page, points);
    await emptied.evaluate((tag) => tag.parentNode?.removeChild(tag));
    return difference(served, empty);
  };

  for (const device of [smallLaptop, ipadLandscape, laptop, desktop]) {
    test(`${device.width}×${device.height}: flat and framed cards share their frame, spacing, and corner clipping`, async () => {
      let framed: CardGeometry | undefined;
      let framedShadow: number[][] | undefined;
      for (const { name, path } of pages) {
        const { context, page } = await open(device, path);
        try {
          const shape = await cardGeometry(page);
          // The flat card paints the same shadow below its box as the framed one.
          const shadow = await shadowPaint(page, shape.box, shape.shellSpacing);
          expect(shadow.shadowDepth).toBeGreaterThanOrEqual(2);
          if (framedShadow) expect(difference(shadow.painted, framedShadow)).toBeLessThanOrEqual(1);
          else framedShadow = shadow.painted;
          // Nothing inside the flat card paints past its rounded corners, with its content scrolled to
          // the end. The framed fixture's open detail panel casts its shadow beyond the card on purpose.
          if (name === "flat overview") expect(await cornerLeak(page, shape.box)).toBeLessThanOrEqual(1);
          expect(Number.parseFloat(shape.expectedRadius)).toBeGreaterThan(0);
          expect(shape.radii).toEqual(Array(4).fill(shape.expectedRadius));
          for (const radius of shape.radii) expect(Number.parseFloat(radius)).toBeGreaterThan(0);
          expect(shape.shadow).not.toBe("none");
          expect(Math.abs(shape.shellSpacing - cardInset(device.width))).toBeLessThanOrEqual(0.05);
          for (const radius of shape.radii)
            expect(Math.abs(Number.parseFloat(radius) - cardRadius(device.width))).toBeLessThanOrEqual(0.05);
          expect(shape.railRight).toBe(56);
          expect(shape.box.left).toBe(56);
          for (const gap of [shape.box.top, device.width - shape.box.right, device.height - shape.box.bottom])
            expect(Math.abs(gap - cardInset(device.width))).toBeLessThanOrEqual(0.5);
          expect(shape.workspaceScroll.top).toBeGreaterThan(0);
          expect(shape.workspaceScroll.top).toBeCloseTo(shape.workspaceScroll.end, 0);
          for (const corner of await cornerPaint(page, shape.box))
            expect(corner).toEqual({ corner: corner.corner, outside: false, inside: true });
          expect(shape.pageScroll.height).toBeLessThanOrEqual(shape.pageScroll.clientHeight);
          expect(shape.pageScroll.width).toBeLessThanOrEqual(shape.pageScroll.clientWidth);
          if (framed) {
            expect(shape.radii).toEqual(framed.radii);
            expect(shape.shadow).toBe(framed.shadow);
            expect(shape.box).toEqual(framed.box);
          } else framed = shape;
        } finally {
          await context.close();
        }
      }
    });
  }

  for (const device of [tabletBoundary, ipadPortrait]) {
    test(`${device.width}×${device.height}: flat and framed workspaces share the rounded tablet card`, async () => {
      let framed: CardGeometry | undefined;
      for (const { path } of pages) {
        const { context, page } = await open(device, path);
        try {
          const shape = await cardGeometry(page);
          expect(shape.radii).toEqual(Array(4).fill("20px"));
          expect(shape.shadow).not.toBe("none");
          expect(shape.box).toMatchObject({ left: shape.railRight! + 8, top: 8, right: device.width - 8, bottom: device.height - 8 });
          if (framed) expect(shape.box).toEqual(framed.box);
          else framed = shape;
        } finally {
          await context.close();
        }
      }
    });
  }

  test("phone: a flat overview keeps square corners and no shadow", async () => {
    const { context, page } = await open(phone, "/app/mail/inbox?overview=1");
    try {
      const shape = await cardGeometry(page);
      expect(shape.radii).toEqual(Array(4).fill("0px"));
      expect(shape.shadow).toBe("none");
    } finally {
      await context.close();
    }
  });

  test("1920×1080 dark: flat and framed cards share their border and painted shadow", async () => {
    const cards: { border: string; shadow: number[][] }[] = [];
    for (const { path } of pages) {
      const { context, page } = await open(desktop, path, { theme: "dark" });
      try {
        expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
        const shape = await cardGeometry(page);
        const border = await page.evaluate(
          () => getComputedStyle(document.querySelector(".layout-content-main .k2b-app-workspace")!).borderTopColor,
        );
        const shadow = await shadowPaint(page, shape.box, shape.shellSpacing);
        expect(shadow.shadowDepth).toBeGreaterThanOrEqual(2);
        if (cards[0]) expect(difference(shadow.painted, cards[0].shadow)).toBeLessThanOrEqual(1);
        cards.push({ border, shadow: shadow.painted });
      } finally {
        await context.close();
      }
    }
    expect(cards[0]!.border).not.toBe("rgba(0, 0, 0, 0)");
    expect(cards[1]!.border).toBe(cards[0]!.border);
  });

  test("anonymous 1024×768: a flat workspace already has the card's radius and shadow", async () => {
    const { context, page } = await open({ name: "anonymous laptop", width: 1024, height: 768, touch: false }, "/public?overview=1");
    try {
      const shape = await cardGeometry(page);
      expect(Number.parseFloat(shape.expectedRadius)).toBeGreaterThan(0);
      expect(shape.radii).toEqual(Array(4).fill(shape.expectedRadius));
      expect(shape.shellSpacing).toBe(8);
      expect(shape.shadow).not.toBe("none");
      expect((await shadowPaint(page, shape.box, shape.shellSpacing)).shadowDepth).toBeGreaterThanOrEqual(2);
    } finally {
      await context.close();
    }
  });
});

describe("a page that scrolls its content in a ScrollArea", () => {
  // Phones draw overlay scrollbars; styled ones take space, as classic scrollbars do in desktop browsers.
  // WebKit applies them only to scrollers laid out after the style, so the page loads with it. The
  // 1024 px case shows that the styled scrollbars take space.
  const style =
    "*::-webkit-scrollbar { width: 12px; height: 12px; background: rgb(221 221 221); } *::-webkit-scrollbar-thumb { background: rgb(136 136 136); } * { scrollbar-width: auto !important; scrollbar-color: auto !important; } .card-row { display: flex; width: 100%; }";
  const scrolling = (page: Page) =>
    page.evaluate(() => {
      const area = document.querySelector<HTMLElement>(".layout-content-main > .k2b-scroll-area")!;
      const root = document.documentElement;
      return {
        areaGutter: area.offsetWidth - area.clientWidth,
        areaScrolls: area.scrollHeight > area.clientHeight,
        documentScrolls: root.scrollHeight > root.clientHeight,
      };
    });

  test("600×900 signed in: the content area scrolls and the window stays still", async () => {
    const { context, page } = await open({ name: "narrow window", width: 600, height: 900, touch: false }, "/app/mail/inbox?cards=1", {
      style,
    });
    try {
      expect(await scrolling(page)).toEqual({ areaGutter: 12, areaScrolls: true, documentScrolls: false });
    } finally {
      await context.close();
    }
  });

  test("600×900 anonymous: the document scrolls and reserves no second gutter", async () => {
    const { context, page } = await open({ name: "anonymous narrow window", width: 600, height: 900, touch: false }, "/public?cards=1", {
      style,
    });
    try {
      expect(await scrolling(page)).toEqual({ areaGutter: 0, areaScrolls: false, documentScrolls: true });
      expect(await page.locator(".cloud-tab-bar").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("1024×768: the area scrolls and keeps its stable gutter", async () => {
    const { context, page } = await open({ name: "small laptop", width: 1024, height: 768, touch: false }, "/app/mail/inbox?cards=1", {
      style,
    });
    try {
      expect(await scrolling(page)).toEqual({ areaGutter: 12, areaScrolls: true, documentScrolls: false });
    } finally {
      await context.close();
    }
  });
});

describe("compact workspace navigation", () => {
  const state = (page: Page) =>
    page.evaluate(() => {
      const sidebar = document.getElementById("mail-navigation")!;
      const toggle = document.querySelector<HTMLElement>("[data-app-workspace-sidebar-toggle]")!;
      const rect = sidebar.getBoundingClientRect();
      return {
        open: getComputedStyle(sidebar).visibility === "visible",
        expanded: toggle.getAttribute("aria-expanded"),
        controls: toggle.getAttribute("aria-controls"),
        label: toggle.getAttribute("aria-label"),
        focus: document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute("aria-label") || "",
        contentInert: document.querySelector(".k2b-app-workspace__content")!.hasAttribute("inert"),
        sidebar: { left: Math.round(rect.left), width: Math.round(rect.width), borders: getComputedStyle(sidebar).borderRightWidth },
        main: Math.round(document.querySelector(".k2b-app-workspace__main")!.getBoundingClientRect().left),
      };
    });

  for (const language of ["en", "de"] as const) {
    test(`iPad portrait (${language}): the bar's button opens the navigation over the app and every way out returns focus`, async () => {
      const { context, page } = await open(ipadPortrait, "/app/mail/inbox", { language });
      try {
        const closed = await state(page);
        expect(closed).toMatchObject({ open: false, expanded: "false", controls: "mail-navigation", contentInert: false });
        expect(closed.label).toBe(language === "de" ? "Navigation anzeigen" : "Show navigation");

        // A tap opens it over the app; the work area does not move.
        await page.locator("[data-app-workspace-sidebar-toggle]").tap();
        const opened = await state(page);
        expect(opened).toMatchObject({ open: true, expanded: "true", contentInert: true, focus: "Inbox", main: closed.main });
        expect(opened.sidebar.left).toBe(77);
        expect(opened.sidebar.width).toBe(280);
        expect(opened.sidebar.borders).toBe("0px");

        // Tab stays in the navigation; Escape closes it and returns to the button.
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        expect((await state(page)).focus).toBe("Sent");
        await page.keyboard.press("Tab");
        expect((await state(page)).focus).toBe("Inbox");
        await page.keyboard.press("Shift+Tab");
        expect((await state(page)).focus).toBe("Sent");
        await page.keyboard.press("Escape");
        expect(await state(page)).toMatchObject({ open: false, expanded: "false", contentInert: false, focus: closed.label });

        // The keyboard opens it too; the scrim closes it.
        await page.keyboard.press("Enter");
        expect((await state(page)).open).toBe(true);
        await page.mouse.click(ipadPortrait.width - 40, ipadPortrait.height / 2);
        expect(await state(page)).toMatchObject({ open: false, focus: closed.label });

        // Choosing a mailbox closes it.
        await page.locator("[data-app-workspace-sidebar-toggle]").click();
        await page.getByText("Archive").click();
        expect(await state(page)).toMatchObject({ open: false, expanded: "false", contentInert: false });
      } finally {
        await context.close();
      }
    });
  }

  test("leaving the compact range closes the navigation", async () => {
    const { context, page } = await open(ipadPortrait, "/app/mail/inbox");
    try {
      await page.locator("[data-app-workspace-sidebar-toggle]").click();
      expect((await state(page)).open).toBe(true);
      await page.setViewportSize({ width: ipadLandscape.width, height: ipadLandscape.height });
      await page.waitForFunction(
        () => document.querySelector("[data-app-workspace-sidebar-toggle]")?.getAttribute("aria-expanded") === "false",
      );
      expect(await state(page)).toMatchObject({ expanded: "false", contentInert: false });
      await page.setViewportSize({ width: ipadPortrait.width, height: ipadPortrait.height });
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".k2b-app-workspace__head")!).display === "flex");
      expect((await state(page)).open).toBe(false);
    } finally {
      await context.close();
    }
  });
});

describe("profile menu in the rail", () => {
  test("on a fine pointer the menu opens beside the rail, upward from the avatar, with every profile action", async () => {
    for (const language of ["en", "de"] as const) {
      const { context, page } = await open(laptop, "/app/mail/inbox", { language });
      try {
        await page.locator(".layout-profile-preferences__link").focus();
        const menu = await page.evaluate(() => {
          const avatar = document.querySelector(".layout-profile-preferences__link")!.getBoundingClientRect();
          const panel = document.querySelector<HTMLElement>(".layout-profile-preferences__panel")!;
          const rect = panel.getBoundingClientRect();
          return {
            visible: getComputedStyle(panel).visibility,
            left: Math.round(rect.left),
            bottom: Math.round(rect.bottom),
            top: Math.round(rect.top),
            avatarBottom: Math.round(avatar.bottom),
            avatarTop: Math.round(avatar.top),
            avatarWidth: avatar.width,
            avatarHeight: avatar.height,
            avatarLeft: avatar.left,
            avatarRight: avatar.right,
            railRight: Math.round(document.querySelector(".layout-rail")!.getBoundingClientRect().right),
            appearanceLabel: panel.querySelector(".menu-item")?.getAttribute("aria-label"),
            radios: panel.querySelectorAll('[role="radio"]').length,
            items: [...panel.querySelectorAll(".menu-item")].map((item) => item.textContent?.trim()),
          };
        });
        expect(menu.visible).toBe("visible");
        expect(menu.railRight).toBe(56);
        expect(menu.avatarWidth).toBe(44);
        expect(menu.avatarHeight).toBe(44);
        expect(menu.avatarLeft).toBeGreaterThanOrEqual(0);
        expect(menu.avatarRight).toBeLessThanOrEqual(56);
        expect(menu.left).toBeGreaterThanOrEqual(menu.railRight - 8);
        expect(menu.bottom).toBe(menu.avatarBottom);
        expect(menu.top).toBeLessThan(menu.avatarTop);
        expect(menu.items).toEqual(
          language === "de"
            ? ["Hell", "English", "Profileinstellungen", "App", "Abmelden"]
            : ["Light", "Deutsch", "Profile settings", "App", "Sign out"],
        );
        expect(menu.radios).toBe(0);
        expect(menu.appearanceLabel).toBe(
          language === "de" ? "Darstellung: Hell. Wechselt zu Dunkel." : "Appearance: Light. Switches to Dark.",
        );
        // Keyboard users move from the avatar into the menu.
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.closest(".layout-profile-preferences__panel") !== null)).toBe(true);
      } finally {
        await context.close();
      }
    }
  });

  test("on an iPad the avatar is the menu button, and the menu would open upward beside the rail", async () => {
    for (const device of [ipadPortrait, ipadLandscape]) {
      const { context, page } = await open(device, "/app/mail/inbox");
      try {
        const trigger = page.locator(".layout-profile-preferences__dropdown-trigger");
        await expect(trigger.isVisible()).resolves.toBe(true);
        await expect(page.locator(".layout-profile-preferences__link").isVisible()).resolves.toBe(false);
        expect(await page.locator(".layout-profile-preferences [data-position]").getAttribute("data-position")).toBe("right-start");
        // Beside the rail, the avatar's menu cannot open below the window's bottom edge, so it grows upward.
        const avatar = await trigger.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
        const menu = dropdownPosition(avatar, { width: 224, height: 220 }, "right-start", { width: device.width, height: device.height });
        expect(avatar.width).toBe(44);
        expect(avatar.height).toBe(44);
        expect(avatar.left).toBeGreaterThanOrEqual(0);
        expect(avatar.right).toBeLessThanOrEqual(tablet(device) ? 68 : 56);
        expect(menu.left).toBeGreaterThanOrEqual(avatar.right);
        expect(menu.top + 220).toBeLessThanOrEqual(device.height - 8);
        expect(menu.top).toBeLessThan(avatar.top);
      } finally {
        await context.close();
      }
    }
  });
});

describe("anonymous pages", () => {
  // Without an app bar, the header keeps the phone's app name, help, and search up to lg; from lg it shows the trail.
  const header = (page: Page) =>
    page.evaluate(() => {
      const visible = (element: Element | null) => Boolean(element?.checkVisibility());
      const header = document.querySelector(".layout-header")!;
      return {
        header: getComputedStyle(header).display,
        signIn: visible(header.querySelector('a[href="/auth/login"]')),
        help: visible(header.querySelector('[aria-label="Open help"]')),
        breadcrumbs: visible(header.querySelector("nav")),
        rail: document.querySelector(".layout-rail"),
      };
    });

  for (const device of devices) {
    test(`${device.name}: keep the header with sign-in and no rail`, async () => {
      const { context, page } = await open(device, "/public");
      try {
        expect(await header(page)).toEqual({
          header: "flex",
          signIn: true,
          help: device.width < 1024,
          breadcrumbs: device.width >= 1024,
          rail: null,
        });
      } finally {
        await context.close();
      }
    });
  }
});

describe("phone header", () => {
  test("a long title keeps Home in the signed-in bar and in the anonymous header", async () => {
    const long = encodeURIComponent("Kundenverwaltung und Abrechnung");
    for (const path of [`/app/mail/inbox?name=${long}`, `/public?title=${long}`]) {
      const { context, page } = await open(phone, path);
      try {
        const home = await page
          .locator(path.startsWith("/public") ? '.layout-header a[href="/"]:has(img)' : '.cloud-tab-bar a[href="/"]')
          .evaluate((link) => link.getBoundingClientRect().toJSON() as DOMRect);
        if (path.startsWith("/public"))
          expect({ width: Math.round(home.width), height: Math.round(home.height) }).toEqual({ width: 32, height: 32 });
        else {
          expect(home.height).toBe(50);
          expect(home.width).toBeGreaterThanOrEqual(44);
          expect(await page.locator('.layout-header a[href="/"]').count()).toBe(0);
        }
      } finally {
        await context.close();
      }
    }
  });
});

describe("workspace detail", () => {
  // Pages that are not `fullPage` grow with their content on a phone, so the sheet must not hang from the
  // bottom of the content area: it belongs to the window.
  for (const list of ["scroll", "page"] as const) {
    test(`phone, ${list === "scroll" ? "a page that grows with its list" : "a full page"}: the half sheet sits at the window's bottom edge and the last row scrolls above it`, async () => {
      const { context, page } = await open(phone, `/app/mail/inbox?list=${list}`);
      try {
        const sheet = await page
          .locator(".k2b-app-workspace__detail")
          .evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
        expect(Math.round(sheet.bottom)).toBe(phone.height);
        expect(sheet.height).toBeCloseTo(phone.height * 0.55, 0);
        const last = await page.evaluate(() => {
          const main = document.querySelector(".k2b-app-workspace__main")!;
          main.scrollTop = main.scrollHeight;
          window.scrollTo(0, document.scrollingElement!.scrollHeight);
          return [...document.querySelectorAll(".list-row")].at(-1)!.getBoundingClientRect().bottom;
        });
        expect(last).toBeLessThanOrEqual(sheet.top);
      } finally {
        await context.close();
      }
    });
  }

  test("iPad portrait: a server-rendered panel with its own close control overlays Main as a drawer", async () => {
    const { context, page } = await open(ipadPortrait, "/app/mail/inbox?list=page");
    try {
      const widths = await page.evaluate(() =>
        [".k2b-app-workspace__content", ".k2b-app-workspace__main"].map((selector) =>
          Math.round(document.querySelector(selector)!.getBoundingClientRect().width),
        ),
      );
      expect(widths[1]).toBe(widths[0]!);
    } finally {
      await context.close();
    }
  });
});

describe("soft tablet and phone shell", () => {
  // Keyboard focus must paint a whole ring through every ancestor that clips it.
  const focusRing = async (page: Page, selector: string) => {
    await page.keyboard.press("Tab");
    await page.locator(selector).first().focus();
    const ring = await page
      .locator(selector)
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        const expansion = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
        const rect = element.getBoundingClientRect();
        const clipped: string[] = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent);
          const box = parent.getBoundingClientRect();
          if (css.overflowX !== "visible" && (rect.left - expansion < box.left - 0.01 || rect.right + expansion > box.right + 0.01))
            clipped.push(`${parent.className}:x`);
          if (css.overflowY !== "visible" && (rect.top - expansion < box.top - 0.01 || rect.bottom + expansion > box.bottom + 0.01))
            clipped.push(`${parent.className}:y`);
        }
        return { visible: element.matches(":focus-visible"), width: Number.parseFloat(style.outlineWidth), clipped };
      });
    expect(ring.visible).toBe(true);
    expect(ring.width).toBeGreaterThan(0);
    expect(ring.clipped).toEqual([]);
  };

  for (const theme of ["light", "dark"] as const) {
    for (const device of [ipadPortrait, { name: "tablet boundary", width: 768, height: 1024, touch: true }]) {
      test(`${device.width} ${theme}: gradient rail and card keep 8 px spacing outside safe areas`, async () => {
        for (const insets of [
          { top: 0, right: 0, bottom: 0, left: 0 },
          { top: 24, right: 12, bottom: 20, left: 16 },
        ]) {
          const { context, page } = await open(device, "/app/mail/inbox", { theme, insets });
          try {
            const shape = await geometry(page, false);
            expect(shape.rail!.box).toMatchObject({
              left: insets.left + 8,
              top: insets.top + 8,
              width: 60,
              bottom: device.height - insets.bottom - 8,
            });
            expect(shape.workspace!.box).toMatchObject({
              left: insets.left + 76,
              top: insets.top + 8,
              right: device.width - insets.right - 8,
              bottom: device.height - insets.bottom - 8,
            });
            expect(shape.workspace!.box.left - shape.rail!.box.right).toBe(8);
            expect(shape.workspace!.radius).toBe("20px");
            expect(shape.workspace!.shadow).not.toBe("none");
            const rail = await page.locator(".layout-rail").evaluate((element) => ({
              radius: getComputedStyle(element).borderRadius,
              background: getComputedStyle(element).backgroundImage,
            }));
            expect(rail.radius).toBe("20px");
            expect(rail.background).toContain("gradient");
            expect(await page.locator(".cloud-tab-bar").isVisible()).toBe(false);
            if (device.width === 834) await focusRing(page, ".layout-rail [data-cloud-rail-apps] a");
          } finally {
            await context.close();
          }
        }
      });
    }

    for (const device of [phone, ipadSplitView]) {
      test(`${device.width} ${theme}: the soft card scrolls while the window stays put and rows clear the floating bar`, async () => {
        // A regular page scrolls `main`, a workspace its Main, a page with a ScrollArea that area.
        for (const [path, scroller, row] of [
          ["/app/mail/inbox?plain=1", "main.layout-content-main", ".plain-row"],
          ["/app/mail/inbox?overview=1", ".k2b-app-workspace__main", ".overview-row"],
          ["/app/mail/inbox?cards=1", ".layout-content-main > .k2b-scroll-area", ".card-row"],
        ] as const) {
          for (const bottom of [0, 34]) {
            const { context, page } = await open(device, path, { theme, insets: { bottom } });
            try {
              const styles = await page.evaluate(() => {
                const header = getComputedStyle(document.querySelector(".layout-header")!);
                const canvas = getComputedStyle(document.querySelector(".cloud-app-canvas")!);
                const main = document.querySelector<HTMLElement>("main.layout-content-main")!;
                const style = getComputedStyle(main);
                const bar = document.querySelector(".cloud-tab-bar .k2b-tab-bar")!;
                const barStyle = getComputedStyle(bar);
                return {
                  borders: [header.borderTopWidth, header.borderRightWidth, header.borderBottomWidth, header.borderLeftWidth],
                  headerBackground: header.backgroundColor,
                  headerShadow: header.boxShadow,
                  gradient: canvas.backgroundImage,
                  canvasHeight: Number.parseFloat(canvas.height),
                  canvasOverflow: canvas.overflow,
                  radii: [
                    style.borderTopLeftRadius,
                    style.borderTopRightRadius,
                    style.borderBottomRightRadius,
                    style.borderBottomLeftRadius,
                  ],
                  overflow: style.overflowY,
                  padding: Number.parseFloat(style.paddingBottom),
                  scrollPadding: Number.parseFloat(style.scrollPaddingBottom),
                  position: getComputedStyle(document.querySelector(".cloud-tab-bar")!).position,
                  radius: Number.parseFloat(barStyle.borderRadius),
                  barHeight: bar.getBoundingClientRect().height,
                  barBottom: bar.getBoundingClientRect().bottom,
                };
              });
              expect(styles.borders).toEqual(["0px", "0px", "0px", "0px"]);
              expect(styles.headerBackground).toBe("rgba(0, 0, 0, 0)");
              expect(styles.headerShadow).toBe("none");
              expect(styles.gradient).toContain("gradient");
              expect(styles.canvasHeight).toBe(device.height);
              expect(styles.canvasOverflow).toBe("hidden");
              expect(styles.radii).toEqual(["28px", "28px", "0px", "0px"]);
              expect(["auto", "scroll"]).toContain(styles.overflow);
              expect(styles.padding).toBe(bottom + 8 + 62 + 12);
              expect(styles.scrollPadding).toBe(styles.padding);
              expect(await page.locator(".cloud-tab-bar .k2b-tab-bar").isVisible()).toBe(true);
              expect(styles.position).toBe("fixed");
              expect(styles.radius).toBeGreaterThan(20);
              expect(styles.barHeight).toBe(62);
              expect(styles.barBottom).toBe(device.height - bottom - 8);
              const end = await page.evaluate(
                ([scroller, row]) => {
                  const area = document.querySelector<HTMLElement>(scroller)!;
                  const overflowing = area.scrollHeight > area.clientHeight;
                  area.scrollTop = area.scrollHeight;
                  return {
                    overflowing,
                    scrolled: area.scrollTop,
                    document: document.scrollingElement!.scrollTop,
                    last: [...document.querySelectorAll(row)].at(-1)!.getBoundingClientRect().bottom,
                    bar: document.querySelector(".cloud-tab-bar .k2b-tab-bar")!.getBoundingClientRect().top,
                  };
                },
                [scroller, row] as const,
              );
              expect({ path, overflowing: end.overflowing }).toEqual({ path, overflowing: true });
              expect(end.scrolled).toBeGreaterThan(0);
              expect(end.document).toBe(0);
              expect(end.last).toBeLessThanOrEqual(end.bar);
              await page.locator(scroller).evaluate((area) => {
                area.scrollTop = 0;
              });
              await page.locator(row).last().focus();
              const focused = await page.evaluate(() => ({
                bottom: document.activeElement!.getBoundingClientRect().bottom,
                bar: document.querySelector(".cloud-tab-bar .k2b-tab-bar")!.getBoundingClientRect().top,
                document: document.scrollingElement!.scrollTop,
              }));
              expect(focused.bottom).toBeLessThanOrEqual(focused.bar);
              expect(focused.document).toBe(0);
              if (device.width === 390 && bottom === 0 && path.includes("overview")) await focusRing(page, ".cloud-tab-bar a");
            } finally {
              await context.close();
            }
          }
        }
      });
    }
  }

  test("bar links follow personal rail order, keep the later current app and allow native navigation", async () => {
    // Without an open detail: its half sheet rises over the bar, as a sheet does.
    const { context, page } = await open(phone, "/app/mail/inbox?catalog=1&overview=1");
    try {
      const links = await page
        .locator(".cloud-tab-bar a")
        .evaluateAll((links) => links.map((link) => ({ href: link.getAttribute("href"), current: link.getAttribute("aria-current") })));
      expect(links).toEqual([
        { href: "/", current: null },
        { href: "/app/amber", current: null },
        { href: "/app/birch", current: null },
        { href: "/app/cedar", current: null },
        { href: "/app/mail", current: "page" },
      ]);
      // Records whether anything prevented the link's own navigation, then stops it: the page is set from markup.
      await page.evaluate(() =>
        window.addEventListener(
          "click",
          (event) => {
            document.body.dataset.clickPrevented = String(event.defaultPrevented);
            event.preventDefault();
          },
          { once: true },
        ),
      );
      await page.locator('.cloud-tab-bar a[href="/app/amber"]').click();
      expect(await page.locator("body").getAttribute("data-click-prevented")).toBe("false");
    } finally {
      await context.close();
    }
  });

  test("Start is current only at the root, independently of query parameters", async () => {
    for (const path of ["/", "/?view=all", "/app/mail/inbox"]) {
      const { context, page } = await open(phone, path);
      try {
        expect(await page.locator('.cloud-tab-bar a[href="/"]').getAttribute("aria-current")).toBe(
          path.startsWith("/app/") ? null : "page",
        );
        expect(await page.locator('.cloud-tab-bar [aria-current="page"]').count()).toBe(1);
      } finally {
        await context.close();
      }
    }
  });

  test("the phone's home destination is labelled in the request locale", async () => {
    for (const [language, label] of [
      ["en", "Home"],
      ["de", "Start"],
    ] as const) {
      const { context, page } = await open(phone, "/app/mail/inbox", { language });
      try {
        expect(await page.locator('.cloud-tab-bar a[href="/"]').textContent()).toBe(label);
      } finally {
        await context.close();
      }
    }
  });
});

// Nothing changes from 1024 px: the shell's rects at the card widths match origin/main's, recorded with
// RECORD_SHELL_BASELINE=1 before the tablet and phone shells changed (both engines, light and dark).
describe("from 1024 px the shell keeps origin/main's geometry", () => {
  const baselinePath = resolve(import.meta.dir, "compact-shell.baseline.json");
  const recording = process.env.RECORD_SHELL_BASELINE === "1";
  const engine = process.env.TEST_BROWSER?.trim() || "chromium";
  type Rects = Record<string, Box | null>;
  type Baselines = Record<string, Record<string, Rects>>;
  const expected: Baselines = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
  const recorded: Record<string, Rects> = {};
  const paths = ["/app/mail/inbox", "/app/mail/inbox?overview=1", "/app/mail/inbox?cards=1", "/app/mail/inbox?notice=1"];
  const rects = (page: Page): Promise<Rects> =>
    page.evaluate(() => {
      const selectors = {
        canvas: ".cloud-app-canvas",
        rail: ".layout-rail",
        railLogo: ".layout-rail-logo",
        railItems: ".layout-rail [data-cloud-rail-apps]",
        avatar: ".layout-rail .layout-profile-preferences",
        shell: ".layout-shell-content",
        notice: ".layout-shell-content .k2b-notice-card",
        main: ".layout-content-main",
        workspace: ".layout-content-main .k2b-app-workspace",
        sidebar: ".k2b-app-workspace__sidebar",
        pane: ".k2b-app-workspace__main-pane",
        detail: ".k2b-app-workspace__detail",
      };
      return Object.fromEntries(
        Object.entries(selectors).map(([key, selector]) => {
          const element = document.querySelector(selector);
          if (!element || !element.checkVisibility()) return [key, null];
          const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
          return [key, { left, top, right, bottom, width, height }];
        }),
      );
    });
  afterAll(() => {
    if (recording) writeFileSync(baselinePath, `${JSON.stringify({ ...expected, [engine]: recorded }, null, 2)}\n`);
  });
  for (const device of [smallLaptop, ipadLandscape, laptop, desktop]) {
    for (const theme of ["light", "dark"] as const) {
      test(`${device.width}×${device.height} ${theme}: rail, card, and workspace stay where they were`, async () => {
        for (const path of paths) {
          const { context, page } = await open(device, path, { theme });
          try {
            const actual = await rects(page);
            const key = `${device.width}x${device.height} ${theme} ${path}`;
            if (recording) {
              recorded[key] = actual;
              continue;
            }
            const before = expected[engine]?.[key];
            expect(before, `Missing ${engine} baseline ${key}; record origin/main with RECORD_SHELL_BASELINE=1`).toBeDefined();
            for (const [name, box] of Object.entries(before!)) {
              expect({ key, name, present: !!actual[name] }).toEqual({ key, name, present: !!box });
              if (!box || !actual[name]) continue;
              for (const edge of ["left", "top", "right", "bottom", "width", "height"] as const)
                expect(Math.abs(actual[name]![edge] - box[edge]), `${key} ${name}.${edge}`).toBeLessThanOrEqual(0.5);
            }
          } finally {
            await context.close();
          }
        }
      });
    }
  }
});
