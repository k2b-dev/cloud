import { describe, expect, test } from "bun:test";
import { conventionCatalogErrors, headingContractErrors, metadataErrors, uiLinkError } from "./documentation-rules";

const validMeta = {
  title: "Page",
  navTitle: "Page",
  section: "Start",
  order: "10",
  description: "A page.",
  tags: "[docs, api]",
  updated: "2026-07-27",
};

describe("documentation metadata", () => {
  test("accepts the canonical frontmatter shape", () => {
    expect(metadataErrors(validMeta)).toEqual([]);
  });

  test("rejects zero order, empty tags, and invalid dates", () => {
    expect(
      metadataErrors({
        ...validMeta,
        order: "0",
        tags: "[]",
        updated: "2026-02-30",
      }),
    ).toEqual(["order must be a positive integer", "tags must be a non-empty inline list", "updated must be a valid YYYY-MM-DD date"]);
  });
});

describe("documentation headings", () => {
  test("requires exactly one leading H1", () => {
    expect(headingContractErrors("# Page\n\n## Detail", "Page")).toEqual([]);
    expect(headingContractErrors("## Detail\n\n# Page", "Page")).toContain("H1 must be the first heading");
    expect(headingContractErrors("# Page\n\n# Again", "Page")).toContain("must contain exactly one H1");
  });
});

const catalog = (...rows: string[]): string =>
  ["| ID | Rule | Why | How to check | Canonical |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
const row = (id: string, canonical = "[Services](/en/docs/server/services-and-results)"): string =>
  `| ${id} | Return a Result. | Reuse business rules. | Manual: read the service. | ${canonical} |`;

describe("convention catalog", () => {
  test("reports duplicate IDs across pages with both locations", () => {
    expect(
      conventionCatalogErrors([
        { file: "one.md", prose: catalog(row("SRV-01")) },
        { file: "two.md", prose: catalog(row("SRV-01")) },
      ]),
    ).toEqual(["two.md:3: duplicate convention ID 'SRV-01' (first in one.md:3)"]);
  });

  test("rejects malformed IDs", () => {
    for (const id of ["SRV-3", "SRV-003", "FOO-01"]) {
      expect(conventionCatalogErrors([{ file: "page.md", prose: catalog(row(id)) }])).toEqual([`page.md:3: invalid convention ID '${id}'`]);
    }
  });

  test("requires exactly one canonical public link", () => {
    for (const canonical of [
      "No link",
      "[One](/en/docs/build) [Two](/en/ui)",
      "[External](https://example.com)",
      "[Catalog](/en/docs/conventions/code-and-server#code-code)",
    ]) {
      expect(conventionCatalogErrors([{ file: "page.md", prose: catalog(row("SRV-01", canonical)) }])).toEqual([
        "page.md:3: convention SRV-01 needs exactly one canonical /en/docs or /en/ui link",
      ]);
    }
    for (const canonical of ["[Build](/en/docs/build)", "[UI](/en/ui)", "[Calendar](/en/ui/content/calendar)"]) {
      expect(conventionCatalogErrors([{ file: "page.md", prose: catalog(row("SRV-01", canonical)) }])).toEqual([]);
    }
  });

  test("requires the five catalog columns", () => {
    expect(conventionCatalogErrors([{ file: "page.md", prose: catalog(row("SRV-01")).replace("| Why |", "| Reason |") }])).toEqual([
      "page.md:1: convention table must use the columns ID | Rule | Why | How to check | Canonical",
    ]);
    expect(
      conventionCatalogErrors([
        {
          file: "page.md",
          prose:
            "| Column | Meaning |\n| --- | --- |\n| ID | Stable reference |\n\n| Prefix | Area | Page |\n| --- | --- | --- |\n| SRV | Server | None |",
        },
      ]),
    ).toEqual([]);
  });

  test("reports gaps instead of allowing deleted rows", () => {
    expect(conventionCatalogErrors([{ file: "page.md", prose: catalog(row("SRV-01"), row("SRV-03")) }])).toEqual([
      "convention IDs for SRV skip SRV-02; retire a rule instead of deleting its row",
    ]);
  });

  test("starts each prefix at 01", () => {
    expect(conventionCatalogErrors([{ file: "page.md", prose: catalog(row("SRV-00")) }])).toEqual([
      "convention IDs for SRV skip SRV-01; retire a rule instead of deleting its row",
    ]);
  });

  test("accepts pipe tables without outer pipes", () => {
    const prose = catalog(row("CODE-01"))
      .split("\n")
      .map((line) => line.slice(1, -1))
      .join("\n");
    expect(conventionCatalogErrors([{ file: "page.md", prose }])).toEqual([]);
  });

  test("requires Rule, Why, and How to check cells", () => {
    expect(conventionCatalogErrors([{ file: "page.md", prose: catalog("| SRV-01 | | | | [Build](/en/docs/build) |") }])).toEqual([
      "page.md:3: convention SRV-01 has an empty 'Rule' cell",
      "page.md:3: convention SRV-01 has an empty 'Why' cell",
      "page.md:3: convention SRV-01 has an empty 'How to check' cell",
    ]);
  });

  test("keeps escaped pipes and inline code pipes inside their cells", () => {
    expect(
      conventionCatalogErrors([
        {
          file: "page.md",
          prose: catalog("| CODE-01 | Accept a \\| b. | Keep `x | y` intact. | Manual: inspect `` `x | y` ``. | [Build](/en/docs/build) |"),
        },
      ]),
    ).toEqual([]);
  });

  test("accepts a two-page catalog and retained rows", () => {
    expect(
      conventionCatalogErrors([
        { file: "one.md", prose: catalog(row("CODE-01"), row("SRV-01")) },
        { file: "two.md", prose: catalog(row("SRV-02").replace("Return a Result.", "Retired. Use SRV-01."), row("ACC-01")) },
      ]),
    ).toEqual([]);
  });
});

describe("UI links", () => {
  const pages = new Map([
    ["/en/ui", new Set(["ui"])],
    ["/en/ui/content/calendar", new Set(["day-and-week-views-with-dayhours"])],
  ]);

  test("rejects routes that are not in the real route table", () => {
    expect(uiLinkError("/en/ui/surfaces/calendar", pages)).toBe("broken UI link '/en/ui/surfaces/calendar'");
  });

  test("rejects an unknown heading anchor", () => {
    expect(uiLinkError("/en/ui/content/calendar#missing", pages)).toBe("missing anchor '#missing' in UI page /en/ui/content/calendar");
  });

  test("accepts known routes, trailing slashes, and decoded heading anchors", () => {
    expect(uiLinkError("/en/ui", pages)).toBeNull();
    expect(uiLinkError("/en/ui/content/calendar/", pages)).toBeNull();
    expect(uiLinkError("/en/ui/content/calendar#day-and-week-views-with-dayhours", pages)).toBeNull();
    expect(uiLinkError("/en/ui/content/calendar#day%2Dand-week-views-with-dayhours", pages)).toBeNull();
  });

  test("ignores other links", () => {
    expect(uiLinkError("/en/docs/build", pages)).toBeNull();
    expect(uiLinkError("https://example.com/en/ui", pages)).toBeNull();
  });
});
