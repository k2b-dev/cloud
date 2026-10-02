import { describe, expect, test } from "bun:test";
import { descriptionPreview } from "./description-preview";

describe("descriptionPreview", () => {
  test("keeps visible Markdown text without its presentation syntax", () => {
    expect(
      descriptionPreview(`
# Launch notes

- Confirm the **release owner**
- Invite the *support team*
- Share the [runbook](https://example.com/runbook)
- Check \`health/status\`

![Architecture](https://example.com/architecture.png)
      `),
    ).toBe("Launch notes Confirm the release owner Invite the support team Share the runbook Check health/status Architecture");
  });

  test("drops task boxes, nested list markers, quotes, rules, and escapes", () => {
    expect(
      descriptionPreview(`**Goal:** a calm stand for the spring fair

---

1. Book the stage
   - [ ] Ask for the __floor plan__
   - [x] Pay the ~~old~~ deposit
> Bring \\*two\\* extension cords
>> Call <https://example.com/venue> first`),
    ).toBe(
      "Goal: a calm stand for the spring fair Book the stage Ask for the floor plan Pay the old deposit Bring *two* extension cords Call https://example.com/venue first",
    );
  });

  test("returns a bounded preview and handles empty descriptions", () => {
    expect(descriptionPreview("   ")).toBeNull();
    expect(descriptionPreview("---\n\n# ")).toBeNull();
    expect(descriptionPreview("A description that is too long", 16)).toBe("A description t…");
  });
});
