import { expect, test } from "bun:test";
import { CliAddressError, matchAreas, parseAdminAddress, parseAreaAddress, parseFileAddress, pickArea } from "./cli-address";
import type { BaseSummary } from "./contracts";
import { entryRefId } from "./resource-ref";

const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const summary = (id: string, name: string): BaseSummary => {
  const [area, kind] = id.split(":") as ["cloud" | "freeipa", "users" | "groups"];
  return { id, area, kind, name, status: "existing", reason: null, indexEnabled: false, versioningEnabled: true };
};
const home = summary(`cloud:users:${uuid("1")}`, "alice");
const team = summary(`cloud:groups:${uuid("2")}`, "team");
const opsCloud = summary(`cloud:groups:${uuid("3")}`, "ops");
const opsIpa = summary(`freeipa:groups:${uuid("4")}`, "ops");
const bases = [home, team, opsCloud, opsIpa];

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof CliAddressError) return error.text;
    throw error;
  }
  throw new Error("expected an address error");
};

test("parses area paths, marks folder targets and keeps colons inside the path", () => {
  expect(parseFileAddress("me:/Documents/report.pdf")).toEqual({
    kind: "path",
    area: { kind: "me" },
    container: "me",
    path: "Documents/report.pdf",
    folder: false,
  });
  expect(parseFileAddress("team:Docs/")).toMatchObject({ area: { kind: "ref", value: "team" }, path: "Docs", folder: true });
  expect(parseFileAddress("me:")).toMatchObject({ path: "", folder: true });
  expect(parseFileAddress("me:/")).toMatchObject({ path: "", folder: true });
  expect(parseFileAddress("team:/a:b.txt")).toMatchObject({ path: "a:b.txt", folder: false });
  expect(parseFileAddress(`${team.id}:/Docs/x.txt`)).toMatchObject({ area: { kind: "id", id: team.id }, path: "Docs/x.txt" });
  expect(parseFileAddress(team.id)).toMatchObject({ area: { kind: "id", id: team.id }, path: "", folder: true });
  expect(parseFileAddress(`${uuid("2")}:/x`)).toMatchObject({ area: { kind: "ref", value: uuid("2") }, path: "x" });
});

test("accepts inline and persisted file IDs and rejects bare names and local paths", () => {
  const inline = entryRefId(team.id, "Docs/x.txt")!;
  expect(parseFileAddress(inline)).toEqual({ kind: "file-id", id: inline });
  const persisted = `p:${"a".repeat(64)}`;
  expect(parseFileAddress(persisted)).toEqual({ kind: "file-id", id: persisted });
  expect(failure(() => parseFileAddress("team")).en).toContain('"team:"');
  for (const local of ["./report.pdf", "/tmp/x", "../x", "~/x"]) expect(failure(() => parseFileAddress(local)).en).toContain("local path");
});

test("parses bare areas for area-only arguments", () => {
  expect(parseAreaAddress("me")).toEqual({ kind: "me" });
  expect(parseAreaAddress("me:/")).toEqual({ kind: "me" });
  expect(parseAreaAddress("team:")).toEqual({ kind: "ref", value: "team" });
  expect(parseAreaAddress(`${team.id}:`)).toEqual({ kind: "id", id: team.id });
  expect(failure(() => parseAreaAddress("team:/Docs")).en).toContain("not an area");
  expect(failure(() => parseAreaAddress("")).en).toContain("not an area");
});

test("resolves me, group IDs and exact names, and never guesses", () => {
  expect(pickArea(bases, { kind: "me" }, "me")).toBe(home.id);
  expect(pickArea(bases, { kind: "ref", value: "team" }, "team")).toBe(team.id);
  expect(pickArea(bases, { kind: "ref", value: uuid("2") }, uuid("2"))).toBe(team.id);
  // A full area ID passes through unchanged, including hidden personal-group areas.
  const hidden = `cloud:groups:${uuid("9")}`;
  expect(pickArea(bases, { kind: "id", id: hidden }, hidden)).toBe(hidden);
  // Names are exact and group-only: a personal area's user name is not a group name.
  expect(matchAreas(bases, { kind: "ref", value: "Team" })).toEqual([]);
  expect(matchAreas(bases, { kind: "ref", value: "alice" })).toEqual([]);

  const ambiguous = failure(() => pickArea(bases, { kind: "ref", value: "ops" }, "ops"));
  expect(ambiguous.en).toBe(
    `409 "ops" matches several areas: cloud/groups/ops (${opsCloud.id}), freeipa/groups/ops (${opsIpa.id}). Use one of these paths or IDs.`,
  );
  expect(ambiguous.de).toStartWith("409 „ops“ passt zu mehreren Bereichen:");
  expect(failure(() => pickArea(bases, { kind: "ref", value: "nope" }, "nope")).en).toStartWith("404 ");
  expect(failure(() => pickArea([team], { kind: "me" }, "me")).en).toStartWith("404 ");
  expect(failure(() => pickArea([home, summary(`freeipa:users:${uuid("5")}`, "alice")], { kind: "me" }, "me")).en).toStartWith(
    '409 "me" matches several areas',
  );
});

test("parses admin directory and archive addresses", () => {
  expect(parseAdminAddress("cloud/groups/team:/trash/x.txt")).toEqual({
    locator: { area: "cloud", kind: "groups", name: "team" },
    path: "trash/x.txt",
  });
  expect(parseAdminAddress(`freeipa/archive/${uuid("6")}`)).toEqual({ locator: { area: "freeipa", archiveId: uuid("6") }, path: "" });
  for (const invalid of ["team:/x", "cloud/team", "cloud/other/team", "nfs/users/alice"])
    expect(failure(() => parseAdminAddress(invalid)).en).toContain("not a directory address");
});
