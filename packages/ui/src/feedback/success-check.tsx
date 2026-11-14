import type { JSX } from "solid-js";

// The success check that draws itself once when it appears: the ring closes, the check follows, and the mark springs
// up a little. It has the geometry of Tabler's `ti-circle-check` (a 24 px grid, 2 px stroke), so it takes the place of
// the glyph at the same size (1em) and colour (currentColor). The stylesheet runs the drawing in
// `--k2b-motion-celebrate`; reduced motion makes it instant, so the finished check stands still. `toast` builds it
// with the DOM, the dialog headers render it with Solid; both share these attributes.

const SVG_NS = "http://www.w3.org/2000/svg";
const svgAttributes = {
  class: "k2b-success-check",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "aria-hidden": "true",
  focusable: "false",
} as const;
// pathLength 1 lets one dash length draw every part; the ring starts at the top.
const ringAttributes = {
  class: "k2b-success-check__ring",
  cx: "12",
  cy: "12",
  r: "9",
  pathLength: "1",
  transform: "rotate(-90 12 12)",
} as const;
const markAttributes = { class: "k2b-success-check__mark", d: "M9 12l2 2l4 -4", pathLength: "1" } as const;

const element = (doc: Document, name: string, attributes: Record<string, string>): SVGElement => {
  const node = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
};

/** A new success check; it draws each time it enters the document. */
export const createSuccessCheck = (doc: Document): SVGElement => {
  const svg = element(doc, "svg", svgAttributes);
  svg.append(element(doc, "circle", ringAttributes), element(doc, "path", markAttributes));
  return svg;
};

export const SuccessCheck = (): JSX.Element => (
  <svg {...svgAttributes}>
    <circle {...ringAttributes} />
    <path {...markAttributes} />
  </svg>
);
