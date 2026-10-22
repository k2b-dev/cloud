import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkDocumentation } from "./check-documentation";
import {
  conventionCatalogErrors,
  conventionCoverageErrors,
  conventionPrefixes,
  headingContractErrors,
  metadataErrors,
  uiHeadingIds,
  uiLinkError,
} from "./documentation-rules";

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

  test("reports unescaped pipes inside code spans and accepts escaped pipes", () => {
    const prose = catalog("| CODE-01 | Accept a \\| b. | Keep `x | y` intact. | Manual: inspect the code. | [Build](/en/docs/build) |");
    expect(conventionCatalogErrors([{ file: "page.md", prose }])).toContain(
      "page.md:3: convention CODE-01 has 6 cells instead of 5; escape '|' as \\|",
    );
    expect(conventionCatalogErrors([{ file: "page.md", prose: prose.replace("`x | y`", "`x \\| y`") }])).toEqual([]);
  });

  test("requires exactly five cells even when the canonical link is in its column", () => {
    const prose = catalog(row("CODE-01").replace(/ \|$/, " | Extra |"));
    expect(conventionCatalogErrors([{ file: "page.md", prose }])).toEqual([
      "page.md:3: convention CODE-01 has 6 cells instead of 5; escape '|' as \\|",
    ]);
  });

  test("accepts a retired row with the replacement's canonical link", () => {
    expect(
      conventionCatalogErrors([
        {
          file: "page.md",
          prose: catalog(row("SRV-01"), row("SRV-02").replace("Return a Result.", "Retired. Replaced by SRV-01.")),
        },
      ]),
    ).toEqual([]);
  });

  test("checks duplicate IDs across all catalog pages during a partial run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cloud-docs-"));
    try {
      const docsRoot = path.join(root, "en");
      const directory = path.join(docsRoot, "conventions");
      await mkdir(directory, { recursive: true });
      const files = [path.join(directory, "a.md"), path.join(directory, "b.md")];
      for (const [index, file] of files.entries()) {
        const frontmatter = Object.entries({ ...validMeta, section: "Conventions", order: String(index + 1) })
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");
        await Bun.write(file, `---\n${frontmatter}\n---\n\n# Page\n\n${catalog(row("SRV-01", "[UI](/en/ui)"))}\n`);
      }
      const result = await checkDocumentation({ docsRoot, requestedPaths: [files[0]] });
      expect(result.checked).toBe(1);
      expect(result.indexed).toBe(2);
      const errors = result.errors.filter((error) => !/convention (?:prefix |index )/.test(error));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("b.md:15: duplicate convention ID 'SRV-01' (first in");
      expect(errors[0]).toContain("a.md:15)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

describe("convention coverage", () => {
  const page = (name: string, prose: string) => ({
    file: `${name}.md`,
    route: `/en/docs/conventions${name === "index" ? "" : `/${name}`}`,
    prose,
  });
  const prefixTable = (prefixes: readonly string[] = conventionPrefixes) =>
    [
      "| Prefix | Area | Page |",
      "| --- | --- | --- |",
      ...prefixes.map((prefix) => `| ${prefix} | Area | [Rules](/en/docs/conventions/rules#area) |`),
    ].join("\n");
  const complete = () => [page("index", prefixTable()), page("rules", catalog(...conventionPrefixes.map((prefix) => row(`${prefix}-01`))))];

  test("reports exactly the missing prefix", () => {
    const pages = complete();
    pages[1].prose = catalog(...conventionPrefixes.filter((prefix) => prefix !== "REL").map((prefix) => row(`${prefix}-01`)));
    const errors = conventionCoverageErrors(pages);
    expect(errors.filter((error) => error.startsWith("convention prefix "))).toEqual([
      "convention prefix REL has no row on any conventions page",
    ]);
    expect(errors).toEqual([
      "convention prefix REL has no row on any conventions page",
      "index.md:14: convention index prefix REL links to /en/docs/conventions/rules, which has no REL rows",
    ]);
  });

  test("reports an index row without a conventions link", () => {
    const pages = complete();
    pages[0].prose = pages[0].prose.replace("[Rules](/en/docs/conventions/rules#area)", "Not catalogued yet");
    expect(conventionCoverageErrors(pages)).toEqual(["index.md:3: convention index prefix CODE needs exactly one conventions page link"]);
  });

  test("reports a link to a page without the prefix's rows", () => {
    const pages = complete();
    pages[0].prose = pages[0].prose.replace("conventions/rules#area", "conventions/other#area");
    pages.push(page("other", catalog(row("SRV-02"))));
    expect(conventionCoverageErrors(pages)).toEqual([
      "index.md:3: convention index prefix CODE links to /en/docs/conventions/other, which has no CODE rows",
    ]);
  });

  test("accepts every prefix and matching index links", () => {
    expect(conventionCoverageErrors(complete())).toEqual([]);
  });

  test("reports a missing index row", () => {
    const pages = complete();
    pages[0].prose = prefixTable(conventionPrefixes.filter((prefix) => prefix !== "REL"));
    expect(conventionCoverageErrors(pages)).toEqual(["index.md: convention index has no prefix row for REL"]);
  });

  test("requires the index and its prefix table", () => {
    expect(conventionCoverageErrors(complete().slice(1))).toEqual(["convention index page /en/docs/conventions is missing"]);
    const pages = complete();
    pages[0].prose = "# Index";
    expect(conventionCoverageErrors(pages)).toEqual([
      "index.md: convention index prefix table is missing",
      ...conventionPrefixes.map((prefix) => `index.md: convention index has no prefix row for ${prefix}`),
    ]);
    expect(conventionCoverageErrors([])).toContain("convention prefix REL has no row on any conventions page");
  });

  test("reports unknown prefixes and multiple or non-catalog links", () => {
    const pages = complete();
    pages[0].prose += "\n| UNKNOWN | Area | [Rules](/en/docs/conventions/rules) |";
    expect(conventionCoverageErrors(pages)).toEqual([
      "index.md:15: convention index has unknown prefix 'UNKNOWN'",
      "index.md:15: convention index prefix UNKNOWN links to /en/docs/conventions/rules, which has no UNKNOWN rows",
    ]);
    for (const link of [
      "[Index](/en/docs/conventions)",
      "[Build](/en/docs/build)",
      "[One](/en/docs/conventions/rules) [Two](/en/docs/conventions/other)",
    ]) {
      const fixture = complete();
      fixture[0].prose = fixture[0].prose.replace("[Rules](/en/docs/conventions/rules#area)", link);
      expect(conventionCoverageErrors(fixture)).toEqual([
        "index.md:3: convention index prefix CODE needs exactly one conventions page link",
      ]);
    }
  });
});

describe("UI links", () => {
  const pages = new Map([
    ["/en/ui", new Set(["ui"])],
    ["/en/ui/content/calendar", new Set(["day-and-week-views-with-dayhours"])],
  ]);

  test("uses Fibel heading IDs and excludes only the first H1", () => {
    const headings = uiHeadingIds("# Title\n\n## Give a host's trail\n\n# Later\n\n```md\n## Code\n```");
    expect(headings).toEqual(new Set(["give-a-host-s-trail", "later"]));
    expect(headings.has("give-a-hosts-trail")).toBe(false);
    const uiPages = new Map([["/en/ui/layout/page-title", headings]]);
    expect(uiLinkError("/en/ui/layout/page-title#give-a-hosts-trail", uiPages)).toBe(
      "missing anchor '#give-a-hosts-trail' in UI page /en/ui/layout/page-title",
    );
    expect(uiLinkError("/en/ui/layout/page-title#give-a-host-s-trail", uiPages)).toBeNull();
  });

  test("strips query strings before resolving UI routes and anchors", () => {
    expect(uiLinkError("/en/ui/content/calendar?view=week#day-and-week-views-with-dayhours", pages)).toBeNull();
    expect(uiLinkError("/en/ui/content/calendar?view=week", pages)).toBeNull();
    expect(uiLinkError("/en/ui/content/calendar?view=week#missing", pages)).toBe(
      "missing anchor '#missing' in UI page /en/ui/content/calendar",
    );
    expect(uiLinkError("/en/ui/missing?view=week#anchor", pages)).toBe("broken UI link '/en/ui/missing?view=week#anchor'");
  });

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
