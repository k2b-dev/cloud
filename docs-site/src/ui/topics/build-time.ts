/**
 * What the UI topic pages read from the repository: the text of every recipe of the `k2b-ui` skill and the props of
 * every component of `@k2b/ui/v2`, read from its types with the type checker on the same path as the rule
 * `v2-primitive-props`. In development and tests the site computes it at start; the production build writes it once
 * as `ui-v2-reference.json` beside the server, so the running site needs neither the recipe files nor TypeScript.
 */
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type ts from "@typescript/typescript6";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
const recipesDirectory = "packages/ui/skills/k2b-ui/recipes";
const v2Entry = resolve(repositoryRoot, "packages/ui/src/v2/index.ts");
const v2Config = resolve(repositoryRoot, "packages/ui/tsconfig.json");

/** Every recipe file by its name without `.tsx`, with its full text. */
export function recipeSources(): Record<string, string> {
  const directory = resolve(repositoryRoot, recipesDirectory);
  return Object.fromEntries(
    readdirSync(directory)
      .filter((file) => file.endsWith(".tsx"))
      .sort()
      .map((file) => [file.slice(0, -".tsx".length), readFileSync(resolve(directory, file), "utf8")]),
  );
}

/** One prop of a part: its name, its type as written, whether it is required, and the first sentence of its TSDoc. */
export type PropRow = { name: string; type: string; required: boolean; description: string };

/**
 * The props of one part of `@k2b/ui/v2` (`Table`, `Pane.Split`) or of one exported object type (`Column`). Props every
 * variant of a union shares stand in `rows`; props only one variant takes stand in a group named by what selects it.
 */
export type PropsDoc = {
  name: string;
  /** `Table<T>` for a generic component. */
  title: string;
  file: string;
  kind: "component" | "type";
  rows: PropRow[];
  /** Alternatives ("With `markdown`", "Or with `children`"): a prop required there is required only in its variant. */
  groups: { title: string; rows: PropRow[] }[];
};

export const firstSentence = (text: string) => {
  const paragraph =
    text
      .trim()
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, " ") ?? "";
  // The first end of a sentence that does not stand inside a quote ("… nicht geladen werden. Deine Ansicht …").
  for (const end of paragraph.matchAll(/[.!?]"?(?=\s+[A-Z(`"„]|$)/g)) {
    const sentence = paragraph.slice(0, end.index + end[0].length);
    if ((sentence.match(/"/g)?.length ?? 0) % 2 === 0) return sentence;
  }
  return paragraph;
};

/** The type of a prop as its author wrote it; a long object literal becomes the list of its keys. */
const typeText = (ts: TypeScript, symbol: ts.Symbol, checker: ts.TypeChecker, at: ts.Node) => {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const node = declaration && (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) ? declaration.type : undefined;
  let text = node ? node.getText() : checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, at));
  text = text.replace(/\s+/g, " ").replace(/;\s*}/g, " }").trim();
  if (text.startsWith("{") && text.length > 48 && node && ts.isTypeLiteralNode(node)) {
    const keys = node.members.map((member) => {
      const name = member.name?.getText() ?? "";
      return member.questionToken ? `${name}?` : name;
    });
    text = `{ ${keys.filter(Boolean).join(", ")} }`;
  }
  return text;
};

type TypeScript = typeof ts;

const propRow = (ts: TypeScript, symbol: ts.Symbol, checker: ts.TypeChecker, at: ts.Node): PropRow => ({
  name: symbol.getName(),
  type: typeText(ts, symbol, checker, at),
  required: (symbol.flags & ts.SymbolFlags.Optional) === 0,
  description: firstSentence(ts.displayPartsToString(symbol.getDocumentationComment(checker))),
});

const byRequired = (rows: PropRow[]) => [...rows.filter((row) => row.required), ...rows.filter((row) => !row.required)];

/** A prop a variant only names to forbid it (`rowKey?: undefined`) is no prop of that variant. */
const forbidden = (row: PropRow) => row.type === "undefined" || row.type === "never";

/**
 * Rows of an object type. A union, also one inside an intersection (`Base & (Keyed | Plain)`), becomes the props every
 * variant shares plus one group per variant with the props of its own, named by the props it requires.
 */
const describeProps = (ts: TypeScript, type: ts.Type, checker: ts.TypeChecker, at: ts.Node) => {
  const propsOf = (member: ts.Type) => checker.getPropertiesOfType(checker.getApparentType(member));
  const parts = type.isIntersection() ? type.types : [type];
  const variantsPart = parts.find((part) => part.isUnion());
  const base = parts.filter((part) => part !== variantsPart).flatMap(propsOf);
  const allowed = (props: readonly ts.Symbol[]) => props.filter((prop) => !forbidden(propRow(ts, prop, checker, at)));
  const variants = variantsPart?.isUnion() ? variantsPart.types.map((variant) => allowed(propsOf(variant))) : [];
  const sharedByVariants =
    variants[0]?.filter((prop) => variants.every((variant) => variant.some((p) => p.getName() === prop.getName()))) ?? [];
  const shared = [...base, ...sharedByVariants];
  const sharedNames = new Set(shared.map((prop) => prop.getName()));
  const rows = (props: readonly ts.Symbol[]) => byRequired(allowed(props).map((prop) => propRow(ts, prop, checker, at)));
  const groups = variants
    .map((variant) => {
      const own = rows(variant.filter((prop) => !sharedNames.has(prop.getName())));
      const selectors = own.filter((row) => row.required).map((row) => `\`${row.name}\``);
      return { title: selectors.length ? `with ${selectors.join(" and ")}` : "with none of them", rows: own };
    })
    .filter((group) => group.rows.length > 0)
    // The variants are alternatives: one is given, never two. "With `markdown`", "Or with `children`".
    .map((group, index) => ({ ...group, title: index === 0 ? `W${group.title.slice(1)}` : `Or ${group.title}` }));
  return { rows: rows(shared), groups };
};

/** The props of every component of `@k2b/ui/v2` and its dotted parts, and the fields of every exported object type. */
export async function v2PropsTables(): Promise<Record<string, PropsDoc>> {
  // Loaded here, not at the top: the production bundle keeps TypeScript out (see build.ts) and never calls this.
  const ts: TypeScript = (await import("@typescript/typescript6")).default;
  const parsed = ts.getParsedCommandLineOfConfigFile(
    v2Config,
    { noEmit: true },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  if (!parsed) throw new Error(`cannot read ${v2Config}`);
  const program = ts.createProgram({ rootNames: [v2Entry], options: parsed.options });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(v2Entry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!source || !module) throw new Error("the v2 entry is no module the type checker can read");
  const fileOf = (symbol: ts.Symbol) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    return declaration ? relative(repositoryRoot, declaration.getSourceFile().fileName) : "";
  };
  const tables: Record<string, PropsDoc> = {};
  const component = (name: string, type: ts.Type, symbol: ts.Symbol, depth: number) => {
    const signature = type.getCallSignatures()[0];
    const parameter = signature?.getParameters()[0];
    if (signature && parameter) {
      const generic = signature.getTypeParameters()?.length
        ? `<${signature
            .getTypeParameters()!
            .map((p) => p.symbol.getName())
            .join(", ")}>`
        : "";
      tables[name] = {
        name,
        title: `${name}${generic}`,
        file: fileOf(symbol),
        kind: "component",
        ...describeProps(ts, checker.getTypeOfSymbolAtLocation(parameter, source), checker, source),
      };
    }
    if (depth >= 3) return;
    for (const part of type.getProperties())
      if (/^[A-Z]/.test(part.getName()))
        component(`${name}.${part.getName()}`, checker.getTypeOfSymbolAtLocation(part, source), part, depth + 1);
  };
  for (const exported of checker.getExportsOfModule(module)) {
    const name = exported.getName();
    if (!/^[A-Z]/.test(name)) continue;
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (symbol.flags & ts.SymbolFlags.Value) {
      component(name, checker.getTypeOfSymbolAtLocation(symbol, source), symbol, 0);
      continue;
    }
    // An exported object type such as `Column` or `NavItem`; the `…Props` types are the components above.
    if (name.endsWith("Props") || !(symbol.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface))) continue;
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    if (type.getCallSignatures().length || !(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Union | ts.TypeFlags.Intersection))) continue;
    // A tuple such as `RowLines` has places, not props.
    if ((type.isUnion() ? type.types : [type]).some((member) => checker.isTupleType(member) || checker.isArrayType(member))) continue;
    if (checker.getPropertiesOfType(checker.getApparentType(type)).length === 0) continue;
    const parameters = (symbol.declarations?.[0] as ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined)?.typeParameters;
    tables[name] = {
      name,
      title: parameters?.length ? `${name}<${parameters.map((p) => p.name.getText()).join(", ")}>` : name,
      file: fileOf(symbol),
      kind: "type",
      ...describeProps(ts, type, checker, source),
    };
  }
  return tables;
}

/** The file the production build writes beside `server.js` (see src/build.ts). */
export const referenceFile = "ui-v2-reference.json";

/** Everything the topic pages read from the repository, in one value the production build writes as JSON. */
export type UiV2Reference = { recipes: Record<string, string>; props: Record<string, PropsDoc> };

export const uiV2Reference = async (): Promise<UiV2Reference> => ({ recipes: recipeSources(), props: await v2PropsTables() });
