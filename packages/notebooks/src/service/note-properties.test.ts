import { describe, expect, test } from "bun:test";
import { dataPropertiesForContent } from "./note-properties";

describe("note data properties", () => {
  test("projects typed properties without hardcoded metadata", () => {
    expect(
      dataPropertiesForContent(`@meta
:::data
status: reviewed
priority: 3
published: true
teams:
  - sales
  - operations
:::`),
    ).toEqual({
      meta: {
        status: "reviewed",
        priority: 3,
        published: true,
        teams: ["sales", "operations"],
      },
    });
  });

  test("invalid namespaces do not prevent independent properties from projecting", () => {
    expect(
      dataPropertiesForContent(`@broken
:::data
nested:
  key: value
:::

@valid
:::data
owner: Ada
:::`),
    ).toEqual({ valid: { owner: "Ada" } });
  });
});
