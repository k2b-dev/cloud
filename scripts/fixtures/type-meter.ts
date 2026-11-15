/**
 * Measures the type of one surface in a browser test, so a test can hold it to
 * the type rule of calm surfaces: at most two text styles (title, entry) plus one
 * quiet meta style, sizes only from the steps 12, 13, 14 and 18 px, and the
 * leading signs of its rows on one axis.
 *
 *   const type = await meterType(page, ".k2b-chat-tasks", { signs: ".k2b-chat-task__mark" });
 *   expect(type.styles).toEqual(["12/400", "13/400", "13/600"]);
 *   expect(type.offSizes).toEqual([]);
 *   expect(type.axes).toHaveLength(1);
 *
 * A style is size plus weight; colour does not count, so a status word in its
 * colour is no style of its own. Only visible text counts: text in hidden,
 * `aria-hidden`, screen-reader-only, keyboard-shortcut and code elements is left
 * out, as are avatars and word marks. A sign leads its row when it is the first
 * sign in the row and sits within `leadWithin` px of the surface's left edge.
 */
/** The part of a Playwright page the meter uses; the fixture itself does not depend on Playwright. */
type EvaluatingPage = { evaluate<R, Arg>(pageFunction: (arg: Arg) => R, arg: Arg): Promise<R> };

export type TypeMeasure = {
  /** Every text style as `size/weight` in px, sorted. */
  styles: string[];
  /** Sizes outside the steps 12, 13, 14 and 18 px. */
  offSizes: number[];
  /** The horizontal centres of leading signs, relative to the surface, rounded to 0.5 px. */
  axes: number[];
  /** One short sample of text per style, to name the culprit in a failing test. */
  samples: Record<string, string>;
};

export type TypeMeterOptions = {
  /** Signs that can lead a row. Default: Tabler icons and icon tiles. */
  signs?: string;
  /** Elements whose text never counts, beside the defaults. */
  ignore?: string;
  /** How far from the left edge a sign still leads its row. Default 48 px. */
  leadWithin?: number;
};

export const TYPE_STEPS = [12, 13, 14, 18] as const;

const defaultIgnore = "[aria-hidden='true'], .k2b-sr-only, kbd, code, pre, .k2b-avatar, [data-type-meter='ignore']";
const rowSelector = "li, a, button, p, dd, dt, tr, h1, h2, h3, h4, h5, h6, [role='row']";

/** The type of the first element that matches `selector`; fails when there is none. */
export const meterType = async (page: EvaluatingPage, selector: string, options: TypeMeterOptions = {}): Promise<TypeMeasure> => {
  const measured = await page.evaluate(
    ({ selector, ignore, signs, leadWithin, rows }) => {
      const root = document.querySelector(selector);
      if (!root) return null;
      const samples: Record<string, string> = {};
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        const element = node.parentElement;
        if (!text || !element || element.closest(ignore)) continue;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        if (style.visibility !== "visible" || box.width <= 1 || box.height <= 1) continue;
        const key = `${Math.round(Number.parseFloat(style.fontSize) * 10) / 10}/${style.fontWeight}`;
        samples[key] ??= text.slice(0, 24);
      }
      const left = root.getBoundingClientRect().left;
      const axes = new Set<number>();
      for (const sign of root.querySelectorAll<HTMLElement>(signs)) {
        const box = sign.getBoundingClientRect();
        if (!box.width || getComputedStyle(sign).visibility !== "visible") continue;
        const row = sign.parentElement?.closest(rows) ?? sign.parentElement;
        if (!row || row.querySelector(signs) !== sign) continue;
        const centre = Math.round((box.left + box.width / 2 - left) * 2) / 2;
        if (centre <= leadWithin) axes.add(centre);
      }
      return { samples, axes: [...axes] };
    },
    {
      selector,
      ignore: options.ignore ? `${defaultIgnore}, ${options.ignore}` : defaultIgnore,
      signs: options.signs ?? "i.ti, .k2b-icon-tile",
      leadWithin: options.leadWithin ?? 48,
      rows: rowSelector,
    },
  );
  if (!measured) throw new Error(`meterType: nothing matches ${selector}`);
  const styles = Object.keys(measured.samples).sort();
  const sizes = [...new Set(styles.map((style) => Number.parseFloat(style)))];
  return {
    styles,
    offSizes: sizes.filter((size) => !(TYPE_STEPS as readonly number[]).includes(size)),
    axes: measured.axes.sort((a, b) => a - b),
    samples: measured.samples,
  };
};
