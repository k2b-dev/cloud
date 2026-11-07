/**
 * Page building blocks for TSX. This text is embedded in @sdk; it imports no framework or renderer. Each block
 * returns the description Core checks and draws; authors compose blocks and never write that description.
 */
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
// A part belongs to exactly one block, such as a field to its form; elsewhere it is an error.
const part = (kind, build) => builder(kind, props => ({ ...(build ? build(props) : props), kind: "#" + kind }));
const parts = (children, kind) => childNodes(children).map(child => {
  if (!child || typeof child !== "object" || child.kind !== "#" + kind) throw new Error("code_page_child");
  const { kind: _kind, ...rest } = child;
  return rest;
});
const noChildren = ({ children, ...props }) => {
  if (childNodes(children).length) throw new Error("code_page_child");
  return props;
};
export const Page = builder("Page", ({ children, ...props }) => ({ kind: "Page", version: 1, ...props, children: childNodes(children) }));
export const Section = builder("Section", ({ children, ...props }) => ({ kind: "Section", ...props, children: childNodes(children) }));
export const Text = builder("Text", ({ children, text, ...props }) => ({ kind: "Text", ...props, text: text ?? textChildren(children) }));
export const Heading = builder("Heading", ({ children, text, ...props }) => ({ kind: "Heading", ...props, text: text ?? textChildren(children) }));
export const Stat = part("Stat", noChildren);
export const Stats = builder("Stats", ({ children, ...props }) => ({ kind: "Stats", ...noChildren(props), items: parts(children, "Stat") }));
export const Column = part("Column", noChildren);
export const Table = builder("Table", ({ children, ...props }) => ({ kind: "Table", ...props, columns: parts(children, "Column") }));
export const Item = part("Item", noChildren);
export const Detail = builder("Detail", ({ children, ...props }) => ({ kind: "Detail", ...props, items: parts(children, "Item") }));
export const Option = part("Option", noChildren);
export const Field = {};
for (const type of ["text", "email", "number", "textarea", "checkbox", "scan"])
  Field[type[0].toUpperCase() + type.slice(1)] = part("Field", props => ({ type, ...noChildren(props) }));
Field.Select = part("Field", ({ children, ...props }) => ({ type: "select", ...props, options: parts(children, "Option") }));
export const Form = builder("Form", ({ children, ...props }) => ({ kind: "Form", ...props, fields: parts(children, "Field") }));
export const Link = builder("Link");
export const Button = builder("Button");
export const Action = builder("Action");
export const Notice = builder("Notice");
export const Chart = {};
for (const kind of ["bar", "line", "scatter", "pie", "donut", "histogram", "gauge", "sparkline", "boxplot", "heatmap", "barGauge", "stat"])
  Chart[kind[0].toUpperCase() + kind.slice(1)] = builder("Chart", ({ width, ...props }) => ({
    kind: "Chart", ...(width === undefined ? {} : { width }), description: { kind, ...noChildren(props) },
  }));
Chart.Empty = builder("Chart", props => ({ kind: "Chart", ...noChildren(props) }));
export function jsx(component, props, ...children) {
  if (!pageComponents.has(component)) throw new Error("code_page_component");
  return component(children.length ? { ...props, children: children.length === 1 ? children[0] : children } : props ?? {});
}
`;
