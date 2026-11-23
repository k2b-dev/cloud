/**
 * A test helper, not part of the package: measures the layout rules of @k2b/ui v2 on a Playwright page, as numbers
 * against the mockup instead of a count of error classes (the lesson of the flat audit, 22.11.).
 *
 * - **edge:** a horizontal hairline or a tinted band reaches both edges of its column (within 1.5 px). A column edge
 *   is a vertical hairline, an element matched by `columns`, or the edge of `root`.
 * - **double:** no two parallel lines lie at most 1 px apart over more than 1 px of length, also across components.
 * - **type:** every run of text is set in a type role: 12, 13, 14 or 18 px on a 16, 20 or 24 px line, in 400, 500 or
 *   600. Reading text (`prose`) may also use 16 px and a 22 px line.
 * - **grip:** the pill of every grip is centred on its 1 px line within ±0.25 CSS px, measured in the DOM and again
 *   in the screenshot at the page's device pixel ratio, inside the grip only.
 *
 * A line is any way to draw one: a border side, a `box-shadow` without blur (offset or spread), a box of at most
 * 1.5 px, and the same on `::before` and `::after`, also under a `display: contents` parent whose own box has no
 * size. To measure a pseudo-element, the helper puts a stand-in element with the pseudo's computed style in its place
 * for the moment of the measurement and restores the page afterwards.
 *
 * Only what a person sees counts: a line or band is cut to the viewport and to every ancestor that clips it (a
 * scrolled column), so content scrolled out of view is measured after scrolling, not before. A rounded box (a
 * control, a mark, an overlay) floats on its own: its outline is no divider and makes no double line.
 *
 * The DOM contract of v2 marks what the rules need: `data-k2-column` (a column), `data-k2-grip` (a grip whose box is
 * its pill), `data-k2-prose` (reading text), `data-k2-figure` (a drawn mark such as the track of steps; its lines are
 * no dividers), `data-k2-canvas` (free drawing, never measured) and `data-k2-avatar` (initials, no type role). The
 * options take other selectors, for the mockup's classes for example.
 *
 * ```ts
 * import { measureV2Layout } from "../../test/measure-v2-layout";
 *
 * for (const deviceScaleFactor of [1, 2])
 *   test(`DPR ${deviceScaleFactor}: the layout keeps the v2 rules`, async () => {
 *     const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor });
 *     await page.setContent(html);
 *     expect((await measureV2Layout(page)).problems).toEqual([]);
 *   });
 * ```
 */
import type { Page } from "playwright";
import { fontWeights, gripTolerance, hairline, typeRoles } from "../src/v2/tokens";

export type V2LayoutOptions = {
  /** The element to measure; the whole body by default. */
  root?: string;
  /** Columns whose edges lines must reach. */
  columns?: string;
  /** Grips; each one's box is its pill. */
  grips?: string;
  /** Reading text, which may also use 16 px and a 22 px line. */
  prose?: string;
  /** Subtrees that are never measured: free drawing in `Canvas`. */
  skip?: string;
  /** Drawn marks whose lines are no dividers, such as the track of steps; their text is still measured. */
  figure?: string;
  /** Text that has no type role, such as initials in an avatar. */
  untyped?: string;
};

export type V2GripMeasure = {
  grip: string;
  /** Pill centre minus line centre in CSS px, from the DOM. */
  dom: number;
  /** The same from the screenshot, or null when the pill or its line could not be told from the background. */
  pixels: number | null;
  /** The width of the line in CSS px, from the screenshot. */
  lineWidth: number | null;
};

export type V2Layout = {
  edge: string[];
  double: string[];
  type: string[];
  grip: string[];
  grips: V2GripMeasure[];
  /** How many hairlines and tinted bands were measured, so a test can tell an empty page from a clean one. */
  measured: { lines: number; bands: number; texts: number };
  /** Every problem as one readable line; empty when the page keeps the rules. */
  problems: string[];
};

type Limits = {
  sizes: number[];
  lineHeights: number[];
  weights: number[];
  hairline: number;
  tolerance: number;
};

type InPage = Required<V2LayoutOptions> & Limits;

type Rect = { left: number; top: number; width: number; height: number };

type DomResult = {
  edge: string[];
  double: string[];
  type: string[];
  grip: string[];
  grips: { grip: string; dom: number; rect: Rect; line: { x0: number; x1: number } | null }[];
  measured: V2Layout["measured"];
};

/** Runs in the page: closes over nothing. */
function measureInPage(options: InPage): DomResult {
  const empty: DomResult = { edge: [], double: [], type: [], grip: [], grips: [], measured: { lines: 0, bands: 0, texts: 0 } };
  const root = document.querySelector(options.root);
  if (!root) return { ...empty, edge: [`no element matches ${options.root}`] };
  const round = (value: number) => Math.round(value * 100) / 100;
  const clear = (color: string) => !color || color === "transparent" || /rgba\(.*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);
  const name = (element: Element) => {
    const marker = element.getAttribute("data-probe");
    if (marker) return `[data-probe="${marker}"]`;
    const pseudo = element.getAttribute("data-k2-stand-in");
    if (pseudo) return pseudo;
    const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return `${element.tagName.toLowerCase()}${classes.map((c) => `.${c}`).join("")}`;
  };

  // 1. Stand-ins for pseudo-elements that draw: read every computed style first, then write, so reading never sees a stand-in.
  const draws = (style: CSSStyleDeclaration) =>
    !clear(style.backgroundColor) ||
    style.backgroundImage !== "none" ||
    style.boxShadow !== "none" ||
    ["top", "right", "bottom", "left"].some(
      (side) =>
        Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 &&
        !["none", "hidden"].includes(style.getPropertyValue(`border-${side}-style`)) &&
        !clear(style.getPropertyValue(`border-${side}-color`)),
    );
  const planned: { owner: Element; which: "before" | "after"; values: [string, string][] }[] = [];
  for (const owner of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (owner.closest(options.skip)) continue;
    for (const which of ["before", "after"] as const) {
      const style = getComputedStyle(owner, `::${which}`);
      if (style.content === "none" || style.content === "normal" || style.display === "none" || !draws(style)) continue;
      const values: [string, string][] = [];
      for (let index = 0; index < style.length; index++) {
        const property = style.item(index);
        if (property !== "content") values.push([property, style.getPropertyValue(property)]);
      }
      planned.push({ owner, which, values });
    }
  }
  const hide = document.createElement("style");
  hide.textContent = "[data-k2-hide-before]::before{content:none!important}[data-k2-hide-after]::after{content:none!important}";
  document.head.append(hide);
  const standIns: Element[] = [];
  for (const { owner, which, values } of planned) {
    const standIn = document.createElement("k2-stand-in");
    for (const [property, value] of values) (standIn as HTMLElement).style.setProperty(property, value);
    standIn.setAttribute("data-k2-stand-in", `${name(owner)}::${which}`);
    owner.setAttribute(`data-k2-hide-${which}`, "");
    if (which === "before") owner.prepend(standIn);
    else owner.append(standIn);
    standIns.push(standIn);
  }

  try {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    };
    const elements = [root, ...Array.from(root.querySelectorAll("*"))].filter(
      (element) => !element.closest(options.skip) && visible(element),
    );
    // What a person sees of an element: the viewport, cut by every ancestor that clips (a scrolled column, the card).
    const clips = new Map<Element, { left: number; right: number; top: number; bottom: number }>();
    const clipOf = (element: Element): { left: number; right: number; top: number; bottom: number } => {
      const known = clips.get(element);
      if (known) return known;
      const parent = element.parentElement;
      let clip = { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
      if (parent) {
        clip = { ...clipOf(parent) };
        const style = getComputedStyle(parent);
        if (style.display !== "contents" && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
          const r = parent.getBoundingClientRect();
          clip = {
            left: Math.max(clip.left, r.left),
            right: Math.min(clip.right, r.right),
            top: Math.max(clip.top, r.top),
            bottom: Math.min(clip.bottom, r.bottom),
          };
        }
      }
      clips.set(element, clip);
      return clip;
    };

    // 2. Every line: border sides, blur-free shadows, and boxes of at most 1.5 px, as far as it can be seen.
    // `frame`: one side of a box framed on several sides, or of a rounded one; it is no divider, so the edge rule skips it.
    // `round`: drawn by a rounded box, a control, mark or overlay; it floats on its own, so the double-line rule skips it.
    type Line = {
      element: Element;
      how: string;
      across0: number;
      across1: number;
      along0: number;
      along1: number;
      frame: boolean;
      round: boolean;
    };
    const horizontal: Line[] = [];
    const vertical: Line[] = [];
    const add = (element: Element, how: string, x0: number, x1: number, y0: number, y1: number, frame: boolean, round: boolean) => {
      // Lines inside a figure (the track of steps, a progress bar) are marks, not dividers.
      if (element.closest(options.figure)) return;
      const clip = clipOf(element);
      const [cx0, cx1, cy0, cy1] = [Math.max(x0, clip.left), Math.min(x1, clip.right), Math.max(y0, clip.top), Math.min(y1, clip.bottom)];
      if (cx1 - cx0 <= 0.25 || cy1 - cy0 <= 0.25) return;
      const line = { element, how, frame: frame || round, round };
      if (x1 - x0 >= y1 - y0) horizontal.push({ ...line, across0: cy0, across1: cy1, along0: cx0, along1: cx1 });
      else vertical.push({ ...line, across0: cx0, across1: cx1, along0: cy0, along1: cy1 });
    };
    const shadowPattern = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(-?[\d.]+)px(\s+inset)?/gi;
    for (const element of elements) {
      const style = getComputedStyle(element);
      const r = element.getBoundingClientRect();
      const sides = ["top", "right", "bottom", "left"].filter(
        (side) =>
          Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 &&
          !["none", "hidden"].includes(style.getPropertyValue(`border-${side}-style`)) &&
          !clear(style.getPropertyValue(`border-${side}-color`)),
      );
      const round = Number.parseFloat(style.borderTopLeftRadius) > 0;
      const framed = sides.length > 1;
      for (const side of sides) {
        const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
        if (side === "top") add(element, "border-top", r.left, r.right, r.top, r.top + width, framed, round);
        if (side === "bottom") add(element, "border-bottom", r.left, r.right, r.bottom - width, r.bottom, framed, round);
        if (side === "left") add(element, "border-left", r.left, r.left + width, r.top, r.bottom, framed, round);
        if (side === "right") add(element, "border-right", r.right - width, r.right, r.top, r.bottom, framed, round);
      }
      if (style.boxShadow !== "none")
        for (const match of style.boxShadow.matchAll(shadowPattern)) {
          const [, color, ox, oy, blur, spread, inset] = match;
          if (clear(color!) || Number(blur) > 0) continue;
          const x = Number(ox);
          const y = Number(oy);
          const s = Number(spread);
          if (s > 0 && x === 0 && y === 0) {
            // A spread without offset draws a frame: inside the box when inset, around it otherwise.
            const [l, rt, tp, b] = inset ? [r.left, r.right, r.top, r.bottom] : [r.left - s, r.right + s, r.top - s, r.bottom + s];
            add(element, "shadow-frame", l, rt, tp, tp + s, true, round);
            add(element, "shadow-frame", l, rt, b - s, b, true, round);
            add(element, "shadow-frame", l, l + s, tp, b, true, round);
            add(element, "shadow-frame", rt - s, rt, tp, b, true, round);
            continue;
          }
          if (s !== 0) continue;
          if (y > 0) add(element, "shadow", r.left, r.right, inset ? r.top : r.bottom, (inset ? r.top : r.bottom) + y, false, round);
          if (y < 0) add(element, "shadow", r.left, r.right, (inset ? r.bottom : r.top) + y, inset ? r.bottom : r.top, false, round);
          if (x > 0) add(element, "shadow", inset ? r.left : r.right, (inset ? r.left : r.right) + x, r.top, r.bottom, false, round);
          if (x < 0) add(element, "shadow", (inset ? r.right : r.left) + x, inset ? r.right : r.left, r.top, r.bottom, false, round);
        }
      const thin = Math.min(r.width, r.height);
      if (thin <= options.hairline + 0.5 && Math.max(r.width, r.height) > 4 * thin && !clear(style.backgroundColor))
        add(element, "box", r.left, r.right, r.top, r.bottom, false, round);
    }
    const hairlines = (lines: Line[]) => lines.filter((line) => line.across1 - line.across0 <= options.hairline + 0.5);

    // 3. Column edges at a height: vertical hairlines, the columns and the root.
    const rootRect = root.getBoundingClientRect();
    const columns = Array.from(root.querySelectorAll(options.columns))
      .filter(visible)
      .map((column) => column.getBoundingClientRect());
    const edgesAt = (y: number) => {
      const lefts = [rootRect.left];
      const rights = [rootRect.right];
      for (const line of hairlines(vertical))
        if (line.along1 - line.along0 > 40 && line.along0 - 1 <= y && line.along1 + 1 >= y) {
          lefts.push(line.across1);
          rights.push(line.across0);
        }
      for (const column of columns)
        if (column.top - 1 <= y && column.bottom + 1 >= y) {
          lefts.push(column.left);
          rights.push(column.right);
        }
      return { lefts, rights };
    };
    const gaps = (x0: number, x1: number, y: number) => {
      const { lefts, rights } = edgesAt(y);
      const left = Math.max(...lefts.filter((x) => x <= x0 + 1.5));
      const right = Math.min(...rights.filter((x) => x >= x1 - 1.5));
      return { left: x0 - left, right: right - x1, edgeLeft: left, edgeRight: right };
    };
    const edge: string[] = [];
    // Collinear pieces of one line (the cells of a row) merge first.
    const dividers = hairlines(horizontal)
      .filter((line) => !line.frame)
      .sort((a, b) => a.across0 - b.across0 || a.along0 - b.along0);
    const merged: Line[] = [];
    for (const line of dividers) {
      const same = merged.find(
        (m) => Math.abs(m.across0 - line.across0) <= 0.6 && line.along0 <= m.along1 + 1.5 && line.along1 >= m.along0 - 1.5,
      );
      if (same) {
        same.along0 = Math.min(same.along0, line.along0);
        same.along1 = Math.max(same.along1, line.along1);
      } else merged.push({ ...line });
    }
    for (const line of merged) {
      if (line.along1 - line.along0 < 60) continue;
      const gap = gaps(line.along0, line.along1, line.across0);
      if (gap.left > 1.5 || gap.right > 1.5)
        edge.push(
          `line ${name(line.element)} ${line.how} at y ${round(line.across0)} stops ${round(gap.left)} px short of the left and ${round(gap.right)} px short of the right edge of its column (${round(gap.edgeLeft)}–${round(gap.edgeRight)})`,
        );
    }
    // Tinted bands: a fill of its own, not a control, not rounded, at least 160 x 36.
    const fillBelow = (element: Element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const color = getComputedStyle(parent).backgroundColor;
        if (!clear(color)) return color;
      }
      return "rgb(255, 255, 255)";
    };
    const control = (element: Element) =>
      !!element.closest(
        "button, a, input, textarea, select, [role=button], [role=tab], [role=option], [role=menuitem], [role=separator], [contenteditable=true], [data-k2-grip]",
      );
    let bands = 0;
    for (const element of elements) {
      const style = getComputedStyle(element);
      const color = style.backgroundColor;
      if (clear(color) || color === fillBelow(element) || control(element) || Number.parseFloat(style.borderTopLeftRadius) > 0) continue;
      const box = element.getBoundingClientRect();
      const clip = clipOf(element);
      const r = {
        left: Math.max(box.left, clip.left),
        right: Math.min(box.right, clip.right),
        top: Math.max(box.top, clip.top),
        bottom: Math.min(box.bottom, clip.bottom),
      };
      if (r.right - r.left < 160 || r.bottom - r.top < 36) continue;
      bands += 1;
      const gap = gaps(r.left, r.right, (r.top + r.bottom) / 2);
      if (gap.left > 1.5 || gap.right > 1.5)
        edge.push(
          `band ${name(element)} at y ${round(r.top)} stops ${round(gap.left)} px short of the left and ${round(gap.right)} px short of the right edge of its column`,
        );
    }

    // 4. Double lines: parallel, at most 1 px apart, sharing more than 1 px of length, of different elements.
    const collapsedPair = (a: Element, b: Element) => {
      const table = a.closest("table");
      return !!table && table === b.closest("table") && getComputedStyle(table).borderCollapse === "collapse";
    };
    const double: string[] = [];
    for (const list of [hairlines(horizontal), hairlines(vertical)]) {
      list.sort((a, b) => a.across0 - b.across0);
      for (const [index, a] of list.entries())
        for (const b of list.slice(index + 1)) {
          if (b.across0 - a.across1 > 1) break;
          if (a.element === b.element || a.round || b.round || collapsedPair(a.element, b.element)) continue;
          const shared = Math.min(a.along1, b.along1) - Math.max(a.along0, b.along0);
          if (shared > 1)
            double.push(
              `double line: ${name(a.element)} ${a.how} and ${name(b.element)} ${b.how} at ${round(a.across0)} px over ${round(shared)} px`,
            );
        }
    }

    // 5. Type roles: every run of text that a person sees.
    const type = new Map<string, number>();
    let texts = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || parent.closest(options.skip) || parent.closest(options.untyped) || !visible(parent))
        continue;
      if (parent.closest("script, style, template")) continue;
      texts += 1;
      const style = getComputedStyle(parent);
      const size = Number.parseFloat(style.fontSize);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const weight = Number(style.fontWeight);
      const prose = !!parent.closest(options.prose);
      const sizeOk = options.sizes.includes(size) || (prose && size === 16);
      const lineOk = options.lineHeights.includes(lineHeight) || (prose && lineHeight === 22);
      if (sizeOk && lineOk && options.weights.includes(weight)) continue;
      const key = `${style.fontSize}/${style.lineHeight} ${weight} in ${name(parent)}`;
      type.set(key, (type.get(key) ?? 0) + 1);
    }

    // 6. Grips: the pill centre against the centre of the vertical hairline that runs through it, above the pill.
    const grip: string[] = [];
    const grips: DomResult["grips"] = [];
    const standInsOf = (element: Element) => Array.from(element.querySelectorAll("k2-stand-in"));
    for (const element of Array.from(root.querySelectorAll(options.grips)).filter(visible)) {
      const r = element.getBoundingClientRect();
      const centre = r.left + r.width / 2;
      const own = new Set([element, ...standInsOf(element)]);
      const y = r.top - 4;
      const candidates = hairlines(vertical)
        .filter(
          (line) =>
            !own.has(line.element) &&
            line.along0 <= y &&
            line.along1 >= y &&
            Math.abs((line.across0 + line.across1) / 2 - centre) <= r.width,
        )
        .sort((a, b) => Math.abs((a.across0 + a.across1) / 2 - centre) - Math.abs((b.across0 + b.across1) / 2 - centre));
      const line = candidates[0];
      const label = name(element);
      if (!line) {
        grip.push(`grip ${label} has no vertical line through it`);
        grips.push({ grip: label, dom: Number.NaN, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, line: null });
        continue;
      }
      const offset = centre - (line.across0 + line.across1) / 2;
      if (Math.abs(offset) > options.tolerance) grip.push(`grip ${label}: pill centre ${round(offset)} px off its line (DOM)`);
      if (Math.abs(line.across1 - line.across0 - options.hairline) > 0.01)
        grip.push(`grip ${label}: its line is ${round(line.across1 - line.across0)} px, not ${options.hairline} px`);
      grips.push({
        grip: label,
        dom: round(offset),
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        line: { x0: line.across0, x1: line.across1 },
      });
    }

    return {
      edge,
      double,
      type: [...type].map(([key, count]) => `text outside the type roles: ${key}${count > 1 ? ` (${count}×)` : ""}`),
      grip,
      grips,
      measured: { lines: horizontal.length + vertical.length, bands, texts },
    };
  } finally {
    for (const standIn of standIns) standIn.remove();
    for (const { owner, which } of planned) owner.removeAttribute(`data-k2-hide-${which}`);
    hide.remove();
  }
}

/** Runs in the page: finds the pill and the line in a screenshot of one grip. */
async function gripPixelsInPage(input: { png: string; scale: number; left: number; top: number; width: number }) {
  const image = new Image();
  image.src = `data:image/png;base64,${input.png}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0);
  const row = (y: number) => {
    const data = context.getImageData(0, Math.min(canvas.height - 1, Math.max(0, Math.round(y))), canvas.width, 1).data;
    return Array.from({ length: canvas.width }, (_, x) => [data[x * 4]!, data[x * 4 + 1]!, data[x * 4 + 2]!]);
  };
  const differs = (a: number[], b: number[]) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!) > 12;
  // The run of pixels between two columns that differ from the background on both sides (the columns left and right
  // of a line may have different fills), in device pixels.
  const run = (pixels: number[][], from: number, to: number) => {
    const before = pixels[from]!;
    const after = pixels[to]!;
    let first = -1;
    let last = -1;
    for (let x = from; x <= to; x++)
      if (differs(pixels[x]!, before) && differs(pixels[x]!, after)) {
        if (first < 0) first = x;
        last = x;
      }
    return first < 0 ? null : { first, last };
  };
  const s = input.scale;
  // Only inside the grip and 3 px around it, so text beside it never counts.
  const from = Math.round((input.left - 3) * s);
  const to = Math.round((input.left + input.width + 3) * s) - 1;
  // The line 3 px above the pill, and the pill 3 px below its top edge, above its first dots.
  const line = run(row((input.top - 3) * s + s / 2), from, to);
  const pill = run(row((input.top + 3) * s + s / 2), from, to);
  if (!line || !pill) return null;
  const centre = (r: { first: number; last: number }) => (r.first + r.last + 1) / 2;
  return { offset: (centre(pill) - centre(line)) / s, lineWidth: (line.last - line.first + 1) / s };
}

/** Measures the v2 layout rules on the page as it stands. Restores the page before it returns. */
export async function measureV2Layout(page: Page, options: V2LayoutOptions = {}): Promise<V2Layout> {
  const roles = Object.values(typeRoles);
  const limits: InPage = {
    root: options.root ?? "body",
    columns: options.columns ?? "[data-k2-column]",
    grips: options.grips ?? "[data-k2-grip]",
    prose: options.prose ?? "[data-k2-prose]",
    skip: options.skip ?? "[data-k2-canvas]",
    figure: options.figure ?? "[data-k2-figure]",
    untyped: options.untyped ?? "[data-k2-avatar]",
    sizes: roles.map((role) => role.size),
    lineHeights: [...new Set(roles.map((role) => role.lineHeight))],
    weights: [...fontWeights],
    hairline: hairline.width,
    tolerance: gripTolerance,
  };
  const dom = await page.evaluate(measureInPage, limits);
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const margin = 6;
  const grips: V2GripMeasure[] = [];
  const grip = [...dom.grip];
  for (const measure of dom.grips) {
    if (!measure.line) continue;
    const { left, top, width, height } = measure.rect;
    // A clip on whole CSS pixels, so the engine never resamples the picture.
    const x = Math.floor(left - margin);
    const y = Math.floor(top - margin);
    const png = await page.screenshot({
      clip: { x, y, width: Math.ceil(width + 2 * margin) + 1, height: Math.ceil(height + 2 * margin) + 1 },
      scale: "device",
      animations: "disabled",
      caret: "hide",
    });
    const pixels = await page.evaluate(gripPixelsInPage, { png: png.toString("base64"), scale, left: left - x, top: top - y, width });
    grips.push({ grip: measure.grip, dom: measure.dom, pixels: pixels?.offset ?? null, lineWidth: pixels?.lineWidth ?? null });
    if (!pixels) grip.push(`grip ${measure.grip}: pill or line not found in the screenshot at DPR ${scale}`);
    else {
      if (Math.abs(pixels.offset) > gripTolerance)
        grip.push(`grip ${measure.grip}: pill centre ${pixels.offset} px off its line in the screenshot at DPR ${scale}`);
      if (Math.abs(pixels.lineWidth - hairline.width) > 0.01)
        grip.push(`grip ${measure.grip}: its line is ${pixels.lineWidth} px wide in the screenshot at DPR ${scale}`);
    }
  }
  const problems = [...dom.edge, ...dom.double, ...dom.type, ...grip];
  return { edge: dom.edge, double: dom.double, type: dom.type, grip, grips, measured: dom.measured, problems };
}
