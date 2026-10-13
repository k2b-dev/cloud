/**
 * Babel transform for SSR - wraps island/client components in custom elements
 * with Seroval JSON props. Handles both SSR (server) and DOM (client) modes.
 */
import { types as t, transformAsync } from "@babel/core";
// @ts-ignore - no types are available for this package
import tsPreset from "@babel/preset-typescript";
// @ts-ignore - no types are available for this package
import solidPreset from "babel-preset-solid";
import { dirname } from "path";
import { islandIdFromFile } from "./island-id";
import { resolveIslandImport } from "./island-resolve";

export { hash } from "./island-id";

// ============================================================================
// Helpers
// ============================================================================

// JSX AST helpers
const jsx = (tag: string, attrs: any[], children: any[] = []) =>
  t.jsxElement(
    t.jsxOpeningElement(t.jsxIdentifier(tag), attrs, children.length === 0),
    children.length ? t.jsxClosingElement(t.jsxIdentifier(tag)) : null,
    children,
    children.length === 0,
  );

const attr = (name: string, value: any) =>
  t.jsxAttribute(t.jsxIdentifier(name), typeof value === "string" ? t.stringLiteral(value) : t.jsxExpressionContainer(value));

// ============================================================================
// Babel Plugin - Wraps island/client components
// ============================================================================

type ComponentType = "island" | "client";

const getComponentType = (path: string): ComponentType | null =>
  path.includes(".island") ? "island" : path.includes(".client") ? "client" : null;

const componentWrapperPlugin = (filename: string, rootDir: string, dev: boolean) => {
  return {
    visitor: {
      Program(programPath: any) {
        const componentImports = new Map<string, { path: string; type: ComponentType; id: string }>();

        // Import Seroval toJSON under an alias so application imports do not collide
        programPath.node.body.unshift(
          t.importDeclaration([t.importSpecifier(t.identifier("__seroval_toJSON"), t.identifier("toJSON"))], t.stringLiteral("seroval")),
        );

        programPath.traverse({
          ImportDeclaration(path: any) {
            const source: string = path.node.source.value;
            const type = getComponentType(source);
            if (!type) return;

            const spec = path.node.specifiers.find((s: any) => s.type === "ImportDefaultSpecifier");
            if (!spec) return;

            const resolvedPath = resolveIslandImport(source, dirname(filename), filename);
            const componentPath = resolvedPath;
            const id = islandIdFromFile(resolvedPath, rootDir);

            componentImports.set(spec.local.name, { path: componentPath, type, id });
          },

          JSXElement(path: any) {
            const name = path.node.openingElement.name.name;
            const component = componentImports.get(name);
            if (!component) return;

            const wrapperTag = component.type === "island" ? "solid-island" : "solid-client";

            const props = t.objectExpression(
              path.node.openingElement.attributes
                .filter((a: any) => a.type === "JSXAttribute")
                .map((a: any) =>
                  t.objectProperty(
                    t.identifier(a.name.name),
                    a.value?.type === "JSXExpressionContainer" ? a.value.expression : a.value || t.booleanLiteral(true),
                  ),
                ),
            );

            // For islands: wrap the component, for client: empty wrapper (no SSR)
            const children = component.type === "island" ? [path.node] : [];

            // Extract filename from path (e.g., "Counter.island.tsx")
            const file = component.path.split("/").pop() || "";

            const attrs = [
              attr("data-id", component.id),
              attr(
                "data-props",
                t.callExpression(t.memberExpression(t.identifier("JSON"), t.identifier("stringify")), [
                  t.callExpression(t.identifier("__seroval_toJSON"), [props]),
                ]),
              ),
            ];

            // Add file attribute in dev mode
            if (dev) {
              attrs.push(attr("data-file", file));
            }

            const wrapper = jsx(wrapperTag, attrs, children);

            path.replaceWith(wrapper);
            path.skip();
          },
        });

        // Client wrappers remove their original JSX usage. Refresh bindings so
        // later presets can discard imports that became unused in this pass.
        programPath.scope.crawl();
      },
    },
  };
};

// ============================================================================
// Transform function
// ============================================================================

export const transform = async (
  source: string,
  filename: string,
  mode: "ssr" | "dom",
  dev: boolean = false,
  rootDir: string = process.cwd(),
): Promise<string> => {
  const result = await transformAsync(source, {
    filename,
    parserOpts: mode === "ssr" ? { plugins: ["jsx", "typescript"] } : undefined,
    plugins: mode === "ssr" ? [() => componentWrapperPlugin(filename, rootDir, dev)] : [],
    presets: [
      [tsPreset, {}],
      [solidPreset, { generate: mode, hydratable: false }],
    ],
  });

  if (!result?.code) throw new Error(`Transform failed: ${filename}`);
  return result.code;
};
