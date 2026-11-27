import { expect, test } from "bun:test";
import { mapTargetField } from "./lookup-display";

test("a lookup's target select reads its colours as hex and drops a colour that is none", () => {
  const target = mapTargetField({
    id: "00000000-0000-0000-0000-000000000001",
    name: "Status",
    type: "select",
    config: {
      options: [
        { id: "open", label: "Open", color: "blue" },
        { id: "done", label: "Done", color: "not-a-colour" },
      ],
    },
    icon: null,
    deleted_at: null,
  });
  expect(target.config.options).toEqual([
    { id: "open", label: "Open", color: "#0000ff" },
    { id: "done", label: "Done" },
  ]);
});
