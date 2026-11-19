import type { Expression, File } from "@babel/parser";
import type { IslandVariants } from "@k2b/ssr";
import { CATALOG_LOCALES, DEFAULT_LOCALE } from "../shared/locale";

/**
 * Per-language island builds: each one ships only the messages its language reads.
 *
 * A Cloud page renders one request locale; its islands resolve every catalog with that locale. The `de` build
 * therefore keeps, for each `i18n.define` catalog, exactly the messages `resolve(["de"])` returns, and the `en` build
 * those of `resolve(["en"])`. Server rendering keeps the full catalogs, so the page and its islands agree.
 *
 * A catalog keeps every language when its result could differ: `messages` or a language is not an inline object
 * literal, a message is a spread, computed, getter, or setter, a language is not one of `CATALOG_LOCALES`, or the base
 * locale is not the default one. Browser code that must read several languages defines its catalog from a variable.
 * Upstream follow-up: this rewrite belongs to `@k2b/stdlib`, the owner of `i18n.define`.
 */

type ObjectExpression = Extract<Expression, { type: "ObjectExpression" }>;
type CallExpression = Extract<Expression, { type: "CallExpression" }>;
type Member = ObjectExpression["properties"][number];
type Node = { type: string };

const variantNames: readonly string[] = CATALOG_LOCALES;

/** The build a request locale loads: its most specific catalog language, otherwise the default build. */
export const catalogVariant = (locale: string | undefined): string => {
  const subtags = (locale ?? "").toLowerCase().split("-");
  for (let length = subtags.length; length > 0; length--) {
    const candidate = subtags.slice(0, length).join("-");
    if (variantNames.includes(candidate)) return candidate;
  }
  return DEFAULT_LOCALE;
};

/** The static key of an object member, or `undefined` when it is computed, a spread, an accessor, or `__proto__`. */
const memberKey = (member: Member): string | undefined => {
  if (member.type === "SpreadElement" || member.computed) return undefined;
  if (member.type === "ObjectMethod" && member.kind !== "method") return undefined;
  const key =
    member.key.type === "Identifier"
      ? member.key.name
      : member.key.type === "StringLiteral"
        ? member.key.value
        : member.key.type === "NumericLiteral"
          ? String(member.key.value)
          : undefined;
  return key === "__proto__" ? undefined : key;
};

const objectLiteral = (member: Member | undefined): ObjectExpression | undefined =>
  member?.type === "ObjectProperty" && member.value.type === "ObjectExpression" ? member.value : undefined;

/** The replacement source of one catalog definition's argument, or `undefined` to keep it whole. */
const rewriteCatalog = (source: string, config: ObjectExpression, variant: string): string | undefined => {
  const options = new Map(config.properties.map((member) => [memberKey(member), member]));
  if (options.size !== 2 || config.properties.length !== 2) return undefined;
  const base = options.get("baseLocale");
  const messages = objectLiteral(options.get("messages"));
  if (base?.type !== "ObjectProperty" || base.value.type !== "StringLiteral" || !messages) return undefined;
  const baseLocale = base.value.value;
  if (baseLocale.toLowerCase() !== DEFAULT_LOCALE) return undefined;

  const locales = new Map<string, { tag: string; members: Member[] }>();
  for (const member of messages.properties) {
    const tag = memberKey(member);
    const value = objectLiteral(member);
    if (tag === undefined || !value || !variantNames.includes(tag.toLowerCase())) return undefined;
    // Tags that differ only in case would make `resolve` depend on their order.
    const known = locales.get(tag.toLowerCase());
    if (known && known.tag !== tag) return undefined;
    if (value.properties.some((message) => memberKey(message) === undefined)) return undefined;
    locales.set(tag.toLowerCase(), { tag, members: value.properties });
  }
  const baseMessages = locales.get(baseLocale.toLowerCase());
  if (!baseMessages || baseMessages.tag !== baseLocale) return undefined;

  // `resolve([variant])`: the most specific defined tag among the variant's subtags, then its defined ancestors over the
  // base messages, the most specific last.
  const subtags = variant.split("-");
  const chain: string[] = [];
  for (let length = 1; length <= subtags.length; length++) {
    const tag = subtags.slice(0, length).join("-");
    if (tag !== baseLocale.toLowerCase() && locales.has(tag)) chain.push(tag);
  }
  const label = locales.get(chain.at(-1) ?? "")?.tag ?? baseLocale;
  const merged = new Map<string, string>();
  for (const locale of [baseLocale.toLowerCase(), ...chain])
    for (const member of locales.get(locale)?.members ?? [])
      merged.set(memberKey(member) ?? "", source.slice(member.start ?? 0, member.end ?? 0));
  const tag = JSON.stringify(label);
  return `{ baseLocale: ${tag}, messages: { ${tag}: { ${[...merged.values()].join(", ")} } } }`;
};

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
const isCall = (node: Node): node is CallExpression => node.type === "CallExpression";

/** Every node below `node`, depth first. */
function* nodes(node: Node): Generator<Node> {
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key.endsWith("Comments")) continue;
    for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) yield* nodes(child);
  }
}

/** Rewrites the inline `i18n.define` catalogs of one module for one language build; other modules stay as they are. */
export const catalogVariantSource = async (source: string, path: string, variant: string): Promise<string> => {
  if (!source.includes("@k2b/stdlib") || !source.includes("define")) return source;
  const { parse } = await import("@babel/parser");
  const typescript = /\.[cm]?tsx?$/.test(path);
  const jsx = /x$/.test(path);
  let program: File["program"];
  try {
    program = parse(source, {
      sourceType: "module",
      plugins: [...(typescript ? (["typescript"] as const) : []), ...(jsx ? (["jsx"] as const) : [])],
    }).program;
  } catch {
    // Bun reports real syntax errors; a module Babel cannot read ships whole.
    return source;
  }

  const namespaces = new Set<string>();
  const defines = new Set<string>();
  for (const statement of program.body)
    if (statement.type === "ImportDeclaration" && statement.source.value === "@k2b/stdlib" && statement.importKind !== "type")
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
        const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
        if (imported === "i18n") namespaces.add(specifier.local.name);
        if (imported === "defineCatalog") defines.add(specifier.local.name);
      }
  if (!namespaces.size && !defines.size) return source;

  const isDefine = (call: CallExpression) =>
    (call.callee.type === "Identifier" && defines.has(call.callee.name)) ||
    (call.callee.type === "MemberExpression" &&
      !call.callee.computed &&
      call.callee.object.type === "Identifier" &&
      namespaces.has(call.callee.object.name) &&
      call.callee.property.type === "Identifier" &&
      call.callee.property.name === "define");

  const edits: { start: number; end: number; text: string }[] = [];
  for (const node of nodes(program)) {
    if (!isCall(node) || !isDefine(node) || node.arguments.length !== 1) continue;
    const [config] = node.arguments;
    if (config?.type !== "ObjectExpression") continue;
    const text = rewriteCatalog(source, config, variant);
    if (text !== undefined) edits.push({ start: config.start ?? 0, end: config.end ?? 0, text });
  }
  let result = source;
  // A catalog nested in another catalog's messages is rewritten alone; the outer one then ships whole.
  let covered = Number.POSITIVE_INFINITY;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    if (edit.end > covered) continue;
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    covered = edit.start;
  }
  return result;
};

/** Cloud's island builds: one per catalog language, chosen by the page's request locale. */
export const catalogIslandVariants = <T extends { lang?: string }>(): IslandVariants<T> => ({
  names: variantNames,
  select: (page) => catalogVariant(page.lang),
  transform: catalogVariantSource,
});
