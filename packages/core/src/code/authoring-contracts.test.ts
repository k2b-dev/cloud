import { expect, test } from "bun:test";
import { CodePermissionSchema } from "@k2b/cloud/code";
import { CODE_INITIAL_PAGE_SOURCE, CODE_INITIAL_SOURCE, CodeAuthoringPermissionSchema, codeInitialFiles } from "./authoring-contracts";

// describeCheck spreads each checker permission into its presentation row, and the row schema is strict:
// a checker field the row does not declare turns every check that carries it into a refused answer.
test("check presentation rows declare every field a checker permission can carry", () => {
  const checker = Object.keys(CodePermissionSchema.shape).sort();
  const presentation = Object.keys(CodeAuthoringPermissionSchema.shape);
  expect(checker.filter((key) => !presentation.includes(key))).toEqual([]);
  expect(
    CodeAuthoringPermissionSchema.safeParse({
      operation: "spaces.task.create",
      target: { type: "spaces.space", id: "sp_2lg8" },
      title: "Logistik",
      typeTitle: "Space",
      own: false,
      file: "code.ts",
      line: 4,
      entrypoints: ["lieferungenEintragen"],
      status: "new",
    }).success,
  ).toBe(true);
});

test("init selects a TSX page for Code accounts and a schedule for personal Code", () => {
  for (const owner of [
    { kind: "resource" as const, ref: { type: "example.box", id: "box_1234" } },
    { kind: "app" as const, appId: "example" },
  ])
    expect(codeInitialFiles(owner)).toEqual({ entry: "code.tsx", files: { "code.tsx": CODE_INITIAL_PAGE_SOURCE } });
  expect(codeInitialFiles({ kind: "person", userId: "11111111-1111-4111-8111-111111111111" })).toEqual({
    entry: "code.ts",
    files: { "code.ts": CODE_INITIAL_SOURCE },
  });
});
