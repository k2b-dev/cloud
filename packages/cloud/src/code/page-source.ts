/** Description builders only. This text is embedded in @sdk; it imports no framework or renderer. */
export const CODE_PAGE_BUILDERS = String.raw`
const pageComponents = new Set();
const childNodes = children => [children].flat(Infinity).filter(value => value !== null && value !== undefined && value !== false);
const textChildren = children => {
  const values = children === undefined ? [] : [children].flat(Infinity);
  if (values.some(value => typeof value !== "string" && typeof value !== "number")) throw new Error("code_page_text");
  return values.join("");
};
const builder = (kind, build) => {
  const component = props => build ? build(props) : { kind, ...props };
  pageComponents.add(component);
  return component;
};
export const Page = builder("Page", ({ children, ...props }) => ({ kind: "Page", version: 1, ...props, children: childNodes(children) }));
export const Section = builder("Section", ({ children, ...props }) => ({ kind: "Section", ...props, children: childNodes(children) }));
export const Text = builder("Text", ({ children, text, ...props }) => ({ kind: "Text", ...props, text: text ?? textChildren(children) }));
export const Heading = builder("Heading", ({ children, text, ...props }) => ({ kind: "Heading", ...props, text: text ?? textChildren(children) }));
export const Table = builder("Table");
export const Form = builder("Form");
export const Detail = builder("Detail");
export const Link = builder("Link");
export const Button = builder("Button");
export const Action = builder("Action");
export const Notice = builder("Notice");
export const Stats = builder("Stats");
export const Chart = builder("Chart");
for (const kind of ["bar", "line", "scatter", "pie", "donut", "histogram", "gauge", "sparkline", "boxplot", "heatmap", "barGauge", "stat"])
  Chart[kind[0].toUpperCase() + kind.slice(1)] = builder("Chart", ({ width, empty, ...props }) => ({
    kind: "Chart", ...(width === undefined ? {} : { width }), ...(empty === undefined ? {} : { empty }), description: { kind, ...props },
  }));
export function jsx(component, props, ...children) {
  if (!pageComponents.has(component)) throw new Error("code_page_component");
  return component(children.length ? { ...props, children: children.length === 1 ? children[0] : children } : props ?? {});
}
`;
