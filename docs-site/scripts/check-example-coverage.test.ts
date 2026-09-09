import { expect, test } from "bun:test";
import { missingExampleImports, packageSpecifiers, type RecipeFixture, recipeFixtureErrors } from "./check-example-coverage";

test("extracts static and dynamic package imports", () => {
  expect(
    packageSpecifiers(`
      import { defineApp } from "@k2b/cloud";
      const module = import("@k2b/ssr/nav");
    `),
  ).toEqual(new Set(["@k2b/cloud", "@k2b/ssr/nav"]));
});

test("reports documented imports without a compile fixture", () => {
  expect(
    missingExampleImports(
      ["@k2b/cloud", "@k2b/cloud/ai/ui", "@k2b/cloud/src/internal"],
      ["@k2b/cloud"],
    ),
  ).toEqual(["@k2b/cloud/ai/ui"]);
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
      new Map([["server/http.md", 'import { respond } from "@k2b/cloud/server";']]),
      new Map([["server-api.ts", 'import { respond } from "@k2b/cloud/server";']]),
    ),
  ).toEqual([]);

  expect(
    recipeFixtureErrors(
      recipes,
      new Map([
        [
          "server/http.md",
          ['import { respond } from "@k2b/cloud/server";', 'import { api } from "@k2b/cloud/browser";'].join("\n"),
        ],
      ]),
      new Map([["server-api.ts", 'import { respond } from "@k2b/cloud/server";']]),
    ),
  ).toEqual(["server/http.md: documented import is not covered by its compile fixture: @k2b/cloud/browser"]);

  expect(
    recipeFixtureErrors(
      [
        ...recipes,
        {
          page: "identity/authorization.md",
          fixtures: ["identity-access.ts"],
        },
      ],
      new Map([["server/http.md", 'import { respond } from "@k2b/cloud/server";']]),
      new Map(),
    ),
  ).toEqual(["server/http.md: compile fixture does not exist: server-api.ts", "identity/authorization.md: recipe page does not exist"]);
});
