import { expect } from "bun:test";
import type { Page } from "playwright";

/**
 * Every floating pill of small controls (`k2b-pill`) has the size of the Notebooks editor pills: 24 px controls, 6 px
 * inside a 1 px edge, so 38 px high with 7 px between the edge and each control's round background on every side.
 */
export const PILL_HEIGHT = 38;
export const PILL_SPACE = 7;

export type PillGeometry = {
  selector: string;
  height: number;
  /** The space between the pill's edge and each visible control, above and below. */
  tops: number[];
  bottoms: number[];
  /** The space at the start and end edge; undefined where the pill starts or ends with text or scrolls on. */
  start?: number;
  end?: number;
  /** Each control's corner radius against half its height: round, so its hover keeps the same space everywhere. */
  round: boolean[];
};

/** Measures every pill that matches `selector` and shows on the page. */
export const measurePills = (page: Page, selector: string): Promise<PillGeometry[]> =>
  page.evaluate((selector) => {
    const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter(shown)
      .map((pill) => {
        const box = pill.getBoundingClientRect();
        const controls = Array.from(pill.querySelectorAll<HTMLElement>(".k2b-button")).filter(
          (control) => shown(control) && !control.closest('[data-overflow="hidden"], [popover], [role="menu"], [role="dialog"]'),
        );
        const rects = controls.map((control) => control.getBoundingClientRect());
        const first = rects[0];
        const last = rects.at(-1);
        const firstChild = Array.from(pill.children).find(shown);
        const startsWithControl = !!first && !!firstChild && firstChild.getBoundingClientRect().left >= first.left - 0.5;
        const lastChild = Array.from(pill.children).filter(shown).at(-1);
        const endsWithControl = !!last && !!lastChild && lastChild.getBoundingClientRect().right <= last.right + 0.5;
        return {
          selector,
          height: box.height,
          tops: rects.map((rect) => rect.top - box.top),
          bottoms: rects.map((rect) => box.bottom - rect.bottom),
          start: startsWithControl && first ? first.left - box.left : undefined,
          end: endsWithControl && last && last.right <= box.right ? box.right - last.right : undefined,
          round: controls.map(
            (control, index) => Number.parseFloat(getComputedStyle(control).borderTopLeftRadius) >= rects[index]!.height / 2 - 0.5,
          ),
        };
      });
  }, selector);

/** Each pill is 38 px high, its controls keep 7 px to its edge on every side, and every control is round. */
export const expectCompactPills = (pills: PillGeometry[]) => {
  expect(pills.length).toBeGreaterThan(0);
  for (const pill of pills) {
    expect({ selector: pill.selector, height: pill.height }).toEqual({ selector: pill.selector, height: PILL_HEIGHT });
    expect(pill.tops.length).toBeGreaterThan(0);
    for (const value of [...pill.tops, ...pill.bottoms, pill.start ?? PILL_SPACE, pill.end ?? PILL_SPACE])
      expect({ selector: pill.selector, space: Math.round(value * 2) / 2 }).toEqual({ selector: pill.selector, space: PILL_SPACE });
    expect(pill.round.every(Boolean)).toBe(true);
  }
};
