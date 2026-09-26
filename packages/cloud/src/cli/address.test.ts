import { describe, expect, test } from "bun:test";
import { cliAmbiguityText, formatCliCandidates, parseCliAddress } from "./address";

describe("parseCliAddress", () => {
  test("treats absolute, relative, and home paths as local", () => {
    for (const raw of ["/tmp/a.md", "./a.md", "../a.md", ".", "..", "~", "~/docs/a:b.md"])
      expect(parseCliAddress(raw)).toEqual({ kind: "local", path: raw });
  });

  test("splits <container>:<path> at the first colon", () => {
    expect(parseCliAddress("Team Docs:ops/backup")).toEqual({ kind: "path", container: "Team Docs", path: "ops/backup" });
    expect(parseCliAddress("docs:a:b")).toEqual({ kind: "path", container: "docs", path: "a:b" });
    expect(parseCliAddress("docs:")).toEqual({ kind: "path", container: "docs", path: "" });
  });

  test("keeps everything else as a bare reference", () => {
    expect(parseCliAddress("ns98Kq")).toEqual({ kind: "ref", ref: "ns98Kq" });
    expect(parseCliAddress(":path")).toEqual({ kind: "ref", ref: ":path" });
    expect(parseCliAddress("ops/backup.md")).toEqual({ kind: "ref", ref: "ops/backup.md" });
    expect(parseCliAddress("~user")).toEqual({ kind: "ref", ref: "~user" });
  });
});

describe("ambiguity", () => {
  const candidates = [
    { path: "ops/backup", id: "Ab12Cd" },
    { path: "ops/backup", id: "Ef34Gh" },
  ];

  test("lists candidates as path (id)", () => {
    expect(formatCliCandidates(candidates)).toBe("ops/backup (Ab12Cd), ops/backup (Ef34Gh)");
  });

  test("renders the shared message in English and German", () => {
    expect(cliAmbiguityText({ value: "backup", resources: { en: "notes", de: "Notizen" }, candidates })).toEqual({
      en: '"backup" matches several notes: ops/backup (Ab12Cd), ops/backup (Ef34Gh). Use one of these paths or IDs.',
      de: "„backup“ passt zu mehreren Notizen: ops/backup (Ab12Cd), ops/backup (Ef34Gh). Verwende einen dieser Pfade oder eine ID.",
    });
  });
});
