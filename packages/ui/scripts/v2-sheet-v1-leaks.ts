import postcss from "postcss";

// v2.css carries the chart's own stylesheet (src/styles/chart.css), so a chart renders with v2.css alone. Every rule of
// it that names v1 (`k2b-`) hangs on a chart: the chart root or one of its parts, a stdlib drawing, or a calendar. A v1
// rule that is not a chart rule, such as the scope `.k2b-ui {…}`, its reset `.k2b-ui * {…}` or a hint
// `.k2b-ui [popover].k2b-tooltip {…}`, would style a v2 page through v2.css and is a leak.
const chartMark = /\.k2b-chart|\.stdlib-chart|\[data-calendar/;

/** The selector without its `:not(…)` groups: a chart named only in `:not()` does not hold the rule on a chart. */
const withoutNot = (selector: string) => {
  let out = "";
  for (let index = 0; index < selector.length; index++) {
    if (!selector.startsWith(":not(", index)) {
      out += selector[index];
      continue;
    }
    let depth = 0;
    for (index += 4; index < selector.length; index++) {
      if (selector[index] === "(") depth++;
      else if (selector[index] === ")" && --depth === 0) break;
    }
  }
  return out;
};

/** Every selector of `css` that names a v1 class without holding the rule on a chart. */
export const v1Leaks = (css: string): string[] => {
  const leaks: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    for (const selector of rule.selectors) {
      if (!selector.includes("k2b-")) continue;
      if (!chartMark.test(withoutNot(selector))) leaks.push(selector);
    }
  });
  return leaks;
};
