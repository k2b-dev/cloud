import { expect, test } from "bun:test";
import { welcomeMarkdown } from "./welcome";

const title = (markdown: string) => markdown.split("\n")[0];
const headings = (markdown: string) => markdown.split("\n").filter((line) => line.startsWith("#")).length;

test("a blank notebook's welcome page is German for a German request and English for every other", () => {
  expect(title(welcomeMarkdown("de"))).toBe("# Willkommen!");
  expect(title(welcomeMarkdown("de-AT"))).toBe("# Willkommen!");
  for (const locale of ["en", "en-GB", "fr", "ja", "", null, undefined]) expect(title(welcomeMarkdown(locale))).toBe("# Welcome!");
});

test("the German welcome page shows the same parts as the English one", () => {
  // the same sections, table and closing line, so neither language gets a poorer first note
  expect(headings(welcomeMarkdown("de"))).toBe(headings(welcomeMarkdown("en")));
  expect(welcomeMarkdown("de").split("\n")).toHaveLength(welcomeMarkdown("en").split("\n").length);
});
