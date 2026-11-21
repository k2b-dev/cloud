import type { CodeChartDescription, CodePageTree } from "./page-contract";
/**
 * Page building blocks for TSX. Blocks return descriptions, never DOM nodes or callback handlers; Core checks the
 * page and draws it. A part such as a field or a column belongs inside its block (`cld code check` names a misplaced
 * one); JSX cannot type which element a child is, so the checker and Core enforce it.
 */
export type CodePageNode = CodePageTree["children"][number];
declare const __codePageBlock: unique symbol;
/** A block made by an SDK component. Only blocks make pages; what a block holds is Cloud's business. */
export type CodePageBlock = { readonly [__codePageBlock]: true };
export type CodePageChild = CodePageBlock | readonly CodePageChild[] | false | null | undefined;
export type CodePageComponent<P> = (props: P) => CodePageBlock;
type CodeNodeProps<K extends CodePageNode["kind"]> = Omit<Extract<CodePageNode, { kind: K }>, "kind">;
type Parts = { children?: CodePageChild };
type NoChildren = { children?: never };
type CodeSectionNode = Extract<CodePageNode, { kind: "Section" }>;
export declare const Page: CodePageComponent<Omit<CodePageTree, "kind" | "version" | "children"> & Parts>;
export declare const Section: CodePageComponent<Omit<CodeSectionNode, "kind" | "children"> & Parts>;
type TextChildren = string | number | readonly (string | number)[];
export declare const Text: CodePageComponent<{ text?: string; children?: TextChildren }>;
export declare const Heading: CodePageComponent<{ text?: string; children?: TextChildren; level?: 2 | 3 | 4 }>;

/** One key figure inside `Stats`: value first, then how it changed against what. */
export declare const Stat: CodePageComponent<CodeNodeProps<"Stats">["items"][number] & NoChildren>;
/** A row of up to six key figures; its children are `Stat` blocks. */
export declare const Stats: CodePageComponent<Parts>;
/** One column inside `Table`; `key` names the row field it shows. */
export declare const Column: CodePageComponent<CodeNodeProps<"Table">["columns"][number] & NoChildren>;
/** Rows are data, such as the result of an SDK call; columns are `Column` children. */
export declare const Table: CodePageComponent<Omit<CodeNodeProps<"Table">, "columns"> & Parts>;
/** One label and value inside `Detail`. */
export declare const Item: CodePageComponent<CodeNodeProps<"Detail">["items"][number] & NoChildren>;
export declare const Detail: CodePageComponent<Omit<CodeNodeProps<"Detail">, "items"> & Parts>;

type CodePageField = CodeNodeProps<"Form">["fields"][number];
type FieldProps<V> = Omit<CodePageField, "type" | "value" | "options"> & { value?: V } & NoChildren;
/** One choice inside `Field.Select`. */
export declare const Option: CodePageComponent<NonNullable<CodePageField["options"]>[number] & NoChildren>;
/** Form fields, each a block of its own inside `Form`. The submitted value arrives under `name`. */
export declare const Field: {
  Text: CodePageComponent<FieldProps<string>>;
  Email: CodePageComponent<FieldProps<string>>;
  Number: CodePageComponent<FieldProps<number>>;
  Textarea: CodePageComponent<FieldProps<string>>;
  Checkbox: CodePageComponent<FieldProps<boolean>>;
  /** A text field with a camera button; the read code goes into the field. */
  Scan: CodePageComponent<FieldProps<string>>;
  /** Its choices are `Option` children. */
  Select: CodePageComponent<Omit<FieldProps<string>, "children"> & Parts>;
};
/** Sends its fields to an own route with POST; its children are `Field` blocks. */
export declare const Form: CodePageComponent<Omit<CodeNodeProps<"Form">, "fields"> & Parts>;
export declare const Link: CodePageComponent<CodeNodeProps<"Link"> & NoChildren>;
export declare const Button: CodePageComponent<Omit<Extract<CodePageNode, { kind: "Button" }>, "kind"> & NoChildren>;
export declare const Notice: CodePageComponent<CodeNodeProps<"Notice"> & NoChildren>;

type CodeChartProps<K> = CodeChartDescription extends infer D
  ? D extends { kind: infer Kind }
    ? K extends Kind
      ? Omit<D, "kind"> & Pick<CodeNodeProps<"Chart">, "width" | "height"> & NoChildren
      : never
    : never
  : never;
/** Charts with their data as props, like `@k2b/ui/charts`; `Chart.Empty` keeps a chart's place while there is no data. */
export declare const Chart: {
  [K in CodeChartDescription["kind"] as Capitalize<K>]: CodePageComponent<CodeChartProps<K>>;
} & {
  Empty: CodePageComponent<{ title: string; empty: string } & Pick<CodeNodeProps<"Chart">, "width" | "height"> & NoChildren>;
};
export declare function jsx<P>(component: CodePageComponent<P>, props: P | null, ...children: CodePageChild[]): CodePageBlock;
export declare namespace jsx {
  namespace JSX {
    type Element = CodePageBlock;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {}
  }
}
