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

  test("keeps comparisons, arrows, spaced asterisks, and email addresses as written", () => {
    expect(descriptionPreview("Keep the talk < 30 minutes.\n\n## Agenda\n- Budget review -> Anna")).toBe(
      "Keep the talk < 30 minutes. Agenda Budget review -> Anna",
    );
    expect(descriptionPreview("Seats for > 200 guests, 2<3")).toBe("Seats for > 200 guests, 2<3");
    expect(descriptionPreview("Plan 3 * 4 tables and 5 ** 2 chairs")).toBe("Plan 3 * 4 tables and 5 ** 2 chairs");
    expect(descriptionPreview("Ask <robin@example.com> for the keys <br/> then <!-- note --> go")).toBe(
      "Ask robin@example.com for the keys then go",
    );
  });

  test("keeps code as written, backslashes included, and a private-use character stays itself", () => {
    expect(descriptionPreview("Match `\\.txt$` files and \\*not\\* here")).toBe("Match \\.txt$ files and *not* here");
    expect(descriptionPreview("Clean up:\n\n```sh\nrm build\\*.tmp\n```\n~~~\nC:\\temp\\*\n~~~")).toBe(
      "Clean up: rm build\\*.tmp C:\\temp\\*",
    );
    expect(descriptionPreview("Icon \ue02a stays")).toBe("Icon \ue02a stays");
  });

  test("drops table pipes, setext underlines, reference links, footnotes, and empty task boxes", () => {
    expect(
      descriptionPreview(`Seating
=====
| Item | Qty |
|:-----|----:|
| Chairs | 40 |

See [the plan][plan] and [the map](https://example.com/Map_(fair))[^1]

[plan]: https://example.com/plan
[^1]: Printed copies at the stand
- [ ]
- [x] Done`),
    ).toBe("Seating Item Qty Chairs 40 See the plan and the map Printed copies at the stand Done");
  });

  test("returns a bounded preview and handles empty descriptions", () => {
    expect(descriptionPreview("   ")).toBeNull();
    expect(descriptionPreview("---\n\n# ")).toBeNull();
    expect(descriptionPreview("A description that is too long", 16)).toBe("A description t…");
  });
});
