/** Keyboard and screen reader behaviour every inspected chart shares (chart-inspection-core in @k2b/ui). */
export const inspectA11y = [
  "One tab stop: Tab focuses the chart, arrow keys move from value to value, Home and End jump to the first and the last.",
  "Enter pins the tooltip and Escape closes it; a tap pins it on touch screens, a swipe scrolls the page instead.",
  "The tooltip is linked to the chart through aria-describedby, so a screen reader reads the inspected values.",
  "The Table view lists every value with column headings and sorts by any column; Copy data copies all rows.",
];

/** Options every chart description shares. */
export const commonOptions = [
  { name: "title", type: "string", description: "What the chart shows; the frame prints it and names the chart for screen readers." },
  { name: "subtitle", type: "string", description: "Unit, period or source in one short line." },
  { name: "tooltip", type: "{ label?, format? }", description: "What tooltips and the table call the value and how they format it." },
];

export const axisOption = (axis: "xAxis" | "yAxis") => ({
  name: axis,
  type: "{ label?, domain?, ticks?, scale?, format? }",
  description: `${axis === "xAxis" ? "Horizontal" : "Vertical"} axis: label, exact [min, max], tick count, "log" scale and a number or date format.`,
});

export const numberFormatOption = {
  name: "format",
  type: "{ style?, currency?, unit?, decimals?, compact? }",
  description: 'Number format by name: "number", "percent" or "currency" with an ISO currency, decimals and compact notation.',
};
