/**
 * Babel transform for SSR - wraps island/client components in custom elements
 * with Seroval JSON props. Handles both SSR (server) and DOM (client) modes.
 */
import { types as t, transformAsync } from "@babel/core";
// @ts-ignore - no types are available for this package
import tsPreset from "@babel/preset-typescript";
// @ts-ignore - no types are available for this package
import solidPlugin from "@solidjs/babel-plugin";
import { dirname, join } from "path";
import { islandIdFromFile } from "./island-id";
import { resolveIslandImport } from "./island-resolve";

export { hash } from "./island-id";

const ISLAND_SERVER = join(import.meta.dir, "island-server.ts");

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
        let usesMergeProps = false;
        let usesIslandRoot = false;

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


            const attributes: any[] = path.node.openingElement.attributes;
            const named = (a: any) =>
              t.objectProperty(
                t.identifier(a.name.name),
                a.value?.type === "JSXExpressionContainer" ? a.value.expression : a.value || t.booleanLiteral(true),
              );
            let props: any;
            if (attributes.some((a) => a.type === "JSXSpreadAttribute")) {
              // Merge spreads exactly like Solid renders them: later sources win, undefined
              // values fall back, and overridden getters are never read.
              const sources: any[] = [];
              let group: any[] = [];
              for (const a of attributes) {
                if (a.type !== "JSXSpreadAttribute") {
                  group.push(named(a));
                  continue;
                }
                if (group.length) sources.push(t.objectExpression(group));
                group = [];
                sources.push(a.argument);
              }
              if (group.length) sources.push(t.objectExpression(group));
              // Solid 2's merge() returns a lazy view that Seroval cannot serialize; island props are data, so copy it.
              props = t.objectExpression([t.spreadElement(t.callExpression(t.identifier("__solid_mergeProps"), sources))]);
              usesMergeProps = true;
            } else {
              props = t.objectExpression(attributes.map(named));
            }

            // Extract filename from path (e.g., "Counter.island.tsx")
            const file = component.path.split("/").pop() || "";
            const serialized = t.callExpression(t.memberExpression(t.identifier("JSON"), t.identifier("stringify")), [
              t.callExpression(t.identifier("__seroval_toJSON"), [props]),
            ]);

            // Islands: island-server.ts renders the wrapper and its own hydration root around the component.
            // Client components: an empty wrapper (no SSR).
            const wrapper =
              component.type === "island"
                ? jsx(
                    "__ssr_IslandRoot",
                    [attr("id", component.id), attr("props", serialized), ...(dev ? [attr("file", file)] : [])],
                    [path.node],
                  )
                : jsx("solid-client", [attr("data-id", component.id), attr("data-props", serialized), ...(dev ? [attr("data-file", file)] : [])]);
            if (component.type === "island") usesIslandRoot = true;

            path.replaceWith(wrapper);
            path.skip();
          },
        });

        if (usesIslandRoot) {
          programPath.node.body.unshift(
            t.importDeclaration(
              [t.importSpecifier(t.identifier("__ssr_IslandRoot"), t.identifier("IslandRoot"))],
              t.stringLiteral(ISLAND_SERVER),
            ),
          );
        }

        if (usesMergeProps) {
          programPath.node.body.unshift(
            t.importDeclaration(
              [t.importSpecifier(t.identifier("__solid_mergeProps"), t.identifier("merge"))],
              t.stringLiteral("solid-js"),
            ),
          );
        }

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
    // Solid 2 ships its JSX compiler as a plugin (@solidjs/babel-plugin), no longer as a preset. Plugins run in order,
    // so the island wrapper sees the JSX before Solid lowers it.
    plugins: [
      ...(mode === "ssr" ? [() => componentWrapperPlugin(filename, rootDir, dev)] : []),
      // Spike: islands hydrate their server markup (Hydration ids per island, see island-server.ts).
      [solidPlugin, { generate: mode, hydratable: true }],
    ],
    presets: [[tsPreset, {}]],
  });

  if (!result?.code) throw new Error(`Transform failed: ${filename}`);
  return result.code;
};
