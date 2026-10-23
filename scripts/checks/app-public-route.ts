import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import type { Finding, Rule } from "./rule";

const PAGE_ROUTE = /^\/(?:app|admin)\//;

/**
 * Every SSR page links `/public/<id>/app.css` and the app favicon, but the gateway routes only declared prefixes.
 * An app whose `defineApp` routes include pages below `/app/` or `/admin/` but no `/public/<id>` prefix renders its
 * pages without its stylesheet.
 */
export const rule: Rule = {
  name: "app-public-route",
  description: "Apps with SSR pages declare the /public/<id> prefix that serves their stylesheet",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const packages = join(workspaceRoot, "packages");
    const configs = existsSync(packages)
      ? readdirSync(packages)
          .map((name) => join(packages, name, "src", "config.ts"))
          .filter(existsSync)
          .sort()
      : [];
    for (const file of configs) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("defineApp(")) continue;
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "routes" &&
          ts.isArrayLiteralExpression(node.initializer) &&
          ts.isObjectLiteralExpression(node.parent) &&
          ts.isCallExpression(node.parent.parent) &&
          ts.isIdentifier(node.parent.parent.expression) &&
          node.parent.parent.expression.text === "defineApp"
        ) {
          const routes = node.initializer.elements.filter(ts.isStringLiteralLike).map((element) => element.text);
          // A constant id (such as MAIL_APP_ID) lives in another module; then any one-segment public prefix counts.
          const id = node.parent.properties.find(
            (property): property is ts.PropertyAssignment =>
              ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "id",
          )?.initializer;
          const servesStylesheet = (route: string) =>
            id && ts.isStringLiteralLike(id) ? route === `/public/${id.text}` : /^\/public\/[^/]+$/.test(route);
          if (routes.some((route) => PAGE_ROUTE.test(route)) && !routes.some(servesStylesheet)) {
            findings.push({
              file,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              message:
                'routes declare SSR pages but no "/public/<id>" prefix; the gateway would answer the app stylesheet and favicon with 404.',
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return findings;
  },
};
