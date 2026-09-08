import { expect, test } from "bun:test";
import { documentedFixtureSource, missingExampleImports, packageSpecifiers, type RecipeFixture, recipeFixtureErrors } from "./check-example-coverage";

test("extracts static and dynamic package imports", () => {
  expect(
    packageSpecifiers(`
      import { defineApp } from "@valentinkolb/cloud";
      const module = import("@k2b/ssr/nav");
    `),
  ).toEqual(new Set(["@valentinkolb/cloud", "@k2b/ssr/nav"]));
});

test("reports documented imports without a compile fixture", () => {
  expect(
    missingExampleImports(
      ["@valentinkolb/cloud", "@valentinkolb/cloud/ai/ui", "@valentinkolb/cloud/src/internal"],
      ["@valentinkolb/cloud"],
    ),
  ).toEqual(["@valentinkolb/cloud/ai/ui"]);
});

test("requires canonical recipe pages and compile fixtures", () => {
  const recipes: RecipeFixture[] = [
    {
      page: "server/http.md",
      fixtures: ["server-api.ts"],
    },
  ];

  expect(
    recipeFixtureErrors(
      recipes,
      new Map([["server/http.md", 'import { respond } from "@valentinkolb/cloud/server";']]),
      new Map([["server-api.ts", 'import { respond } from "@valentinkolb/cloud/server";']]),
    ),
  ).toEqual([]);

  expect(
    recipeFixtureErrors(
      recipes,
      new Map([
        [
          "server/http.md",
          ['import { respond } from "@valentinkolb/cloud/server";', 'import { api } from "@valentinkolb/cloud/browser";'].join("\n"),
        ],
      ]),
      new Map([["server-api.ts", 'import { respond } from "@valentinkolb/cloud/server";']]),
    ),
  ).toEqual(["server/http.md: documented import is not covered by its compile fixture: @valentinkolb/cloud/browser"]);

  expect(
    recipeFixtureErrors(
      [
        ...recipes,
        {
          page: "identity/authorization.md",
          fixtures: ["identity-access.ts"],
        },
      ],
      new Map([["server/http.md", 'import { respond } from "@valentinkolb/cloud/server";']]),
      new Map(),
    ),
  ).toEqual(["server/http.md: compile fixture does not exist: server-api.ts", "identity/authorization.md: recipe page does not exist"]);
});

// Scope migration must preserve subpaths without rewriting unrelated workspace names.
test("compares current compile fixtures with the migrated documentation scope", () => {
  expect(documentedFixtureSource('import { defineApp } from "@valentinkolb/cloud";')).toBe(
    'import { defineApp } from "@k2b/cloud";',
  );
  expect(documentedFixtureSource('import("@valentinkolb/cloud/server")')).toBe('import("@k2b/cloud/server")');
  expect(documentedFixtureSource('import("@valentinkolb/cloud-app-grids")')).toBe('import("@valentinkolb/cloud-app-grids")');
  expect(documentedFixtureSource('import("@k2b/cloud/server")')).toBe('import("@k2b/cloud/server")');
});
