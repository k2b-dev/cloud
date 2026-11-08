/**
 * Page building blocks for TSX. This text is embedded in @sdk after the runtime; it imports no framework or renderer.
 * Each block returns a frozen description that only these blocks can make: Core checks and draws it, and authors
 * compose blocks without ever writing a description.
 */
import { chartKindSchema } from "@k2b/editor/chart-schema";

/** Every kind the chart schema knows is a `Chart.<Kind>` block; a new kind there needs no change here. */
const chartKinds = JSON.stringify(chartKindSchema().options);
export const CODE_PAGE_BUILDERS = String.raw`
const __codePage = (() => {
  const components = new Set();
  const built = new WeakSet();
  const done = node => {
    built.add(node);
    return Object.freeze(node);
  };
  const flat = children => [children].flat(Infinity).filter(value => value !== null && value !== undefined && value !== false);
  // A block's children are blocks made here, never hand-written objects, and never a part outside its block.
  const blocks = children => Object.freeze(flat(children).map(child => {
    if (!built.has(child)) throw new Error("code_page_blocks");
    if (child.kind.startsWith("#")) throw new Error("code_page_child");
    return child;
  }));
  const text = children => {
    const values = children === undefined ? [] : [children].flat(Infinity);
    if (values.some(value => typeof value !== "string" && typeof value !== "number")) throw new Error("code_page_text");
    return values.join("");
  };
  const block = (kind, build) => {
    const component = props => done(build ? build(props ?? {}) : { kind, ...noChildren(props ?? {}) });
    components.add(component);
    return component;
  };
  // A part belongs to exactly one block, such as a field to its form; elsewhere it is an error.
  const part = (kind, build) => block(kind, props => ({ ...(build ? build(props) : noChildren(props)), kind: "#" + kind }));
  const parts = (children, kind) => Object.freeze(flat(children).map(child => {
    if (!built.has(child) || child.kind !== "#" + kind) throw new Error("code_page_child");
    const { kind: _kind, ...rest } = child;
    return Object.freeze(rest);
  }));
  const noChildren = ({ children, ...props }) => {
    if (flat(children).length) throw new Error("code_page_child");
    return props;
  };
  const Page = block("Page", ({ children, ...props }) => ({ kind: "Page", version: 1, ...props, children: blocks(children) }));
  const page = props => __codeSdk.markPage(Page(props));
  components.add(page);
  const Section = block("Section", ({ children, ...props }) => ({ kind: "Section", ...props, children: blocks(children) }));
  const Text = block("Text", ({ children, text: value, ...props }) => ({ kind: "Text", ...props, text: value ?? text(children) }));
  const Heading = block("Heading", ({ children, text: value, ...props }) => ({ kind: "Heading", ...props, text: value ?? text(children) }));
  const Field = {};
  for (const type of ["text", "email", "number", "textarea", "checkbox", "scan"])
    Field[type[0].toUpperCase() + type.slice(1)] = part("Field", props => ({ type, ...noChildren(props) }));
  Field.Select = part("Field", ({ children, ...props }) => ({ type: "select", ...props, options: parts(children, "Option") }));
  const Chart = {};
  for (const kind of ${chartKinds})
    Chart[kind[0].toUpperCase() + kind.slice(1)] = block("Chart", ({ width, height, ...props }) => ({
      kind: "Chart", ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }),
      description: { kind, ...noChildren(props) },
    }));
  Chart.Empty = block("Chart", props => ({ kind: "Chart", ...noChildren(props) }));
  function jsx(component, props, ...children) {
    if (!components.has(component)) throw new Error("code_page_component");
    return component(children.length ? { ...props, children: children.length === 1 ? children[0] : children } : props ?? {});
  }
  return {
    Page: page, Section, Text, Heading, Field, Chart, jsx,
    Stat: part("Stat"),
    Stats: block("Stats", ({ children, ...props }) => ({ kind: "Stats", ...noChildren(props), items: parts(children, "Stat") })),
    Column: part("Column"),
    Table: block("Table", ({ children, ...props }) => ({ kind: "Table", ...props, columns: parts(children, "Column") })),
    Item: part("Item"),
    Detail: block("Detail", ({ children, ...props }) => ({ kind: "Detail", ...props, items: parts(children, "Item") })),
    Option: part("Option"),
    Form: block("Form", ({ children, ...props }) => ({ kind: "Form", ...props, fields: parts(children, "Field") })),
    Link: block("Link"),
    Button: block("Button"),
    Action: block("Action"),
    Notice: block("Notice"),
  };
})();
export const { Page, Section, Text, Heading, Field, Chart, jsx, Stat, Stats, Column, Table, Item, Detail, Option, Form, Link, Button, Action, Notice } = __codePage;
`;
