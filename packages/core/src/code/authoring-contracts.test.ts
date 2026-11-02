import { expect, test } from "bun:test";
import { CodePermissionSchema } from "@k2b/cloud/code";
import { CodeAuthoringPermissionSchema } from "./authoring-contracts";

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
      needsTargetAdmin: true,
      file: "code.ts",
      line: 4,
      entrypoints: ["lieferungenEintragen"],
      status: "new",
    }).success,
  ).toBe(true);
});
