import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { installFirstPartyModules } from "../../cloud-cli/test/fixtures/first-party";
import venueCli, { buildSectionPatch } from "./cli";

const none = { enabled: false, disabled: false };

/** A CLI context that answers each request with the next prepared response and records the paths it was asked for. */
const createContext = (args: string[], responses: Response[]) => {
  const paths: string[] = [];
  const lines: string[] = [];
  const ctx: CloudCliContext = {
    args,
    flags: {},
    options: { profile: "test", server: "http://cloud.test", token: "token", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch: async (path) => {
      paths.push(path);
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected fetch: ${path}`);
      return response;
    },
    readJson: async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(`${response.status} ${typeof value?.message === "string" ? value.message : response.statusText}`);
      return value;
    },
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => lines.push(value),
    json: (value) => lines.push(JSON.stringify(value)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: () => {},
  };
  return { ctx, paths, lines };
};

const venueFixture = (id: string, name: string) => ({
  id,
  name,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  permission: "read",
  publicEnabled: false,
  openMode: "combined",
  signupMode: "both",
});
const venuePage = (prefix: string, from: number, count: number) =>
  Response.json({
    venues: Array.from({ length: count }, (_, index) =>
      venueFixture(`${prefix}${String(from + index).padStart(5, "0")}`, `Venue ${from + index}`),
    ),
  });
const listedNames = (lines: string[]) => (JSON.parse(lines[0]!) as { venues: { name: string }[] }).venues.map((venue) => venue.name);

describe("cld venue reads the venue list page by page", () => {
  test("lists every venue until a page is shorter than a full one, by name as before", async () => {
    const { ctx, paths, lines } = createContext(["list"], [venuePage("V", 0, 100), venuePage("V", 100, 3)]);
    await venueCli.run(ctx);
    expect(paths).toEqual(["/api/venue/venues?limit=100&offset=0", "/api/venue/venues?limit=100&offset=100"]);
    const names = listedNames(lines);
    expect(names).toHaveLength(103);
    expect(names.slice(0, 3)).toEqual(["Venue 0", "Venue 1", "Venue 10"]);
  });

  test("a list that answers the same page again ends instead of looping, and repeats no venue", async () => {
    const { ctx, paths, lines } = createContext(["list"], [venuePage("R", 0, 100), venuePage("R", 0, 100)]);
    await venueCli.run(ctx);
    expect(paths).toEqual(["/api/venue/venues?limit=100&offset=0", "/api/venue/venues?limit=100&offset=100"]);
    expect(listedNames(lines)).toHaveLength(100);
  });

  test("a venue named by its name is found among every page of the search, so a second venue of that name is not missed", async () => {
    const { ctx, paths, lines } = createContext(
      ["use", "Lager Nord"],
      [venuePage("N", 0, 100), Response.json({ venues: [venueFixture("Lager1", "Lager Nord")] })],
    );
    await venueCli.run(ctx);
    // the name is searched on the server, so a person with many venues never reads all of them
    expect(paths).toEqual(["/api/venue/venues?limit=100&offset=0&q=Lager%20Nord", "/api/venue/venues?limit=100&offset=100&q=Lager%20Nord"]);
    expect(lines).toEqual(["Default venue: Lager Nord"]);
  });

  test("a reference that can be an ID is searched by name and read directly, so an equal name makes it ambiguous", async () => {
    const venue = venueFixture("Ven001", "Ven001");
    const { ctx, paths } = createContext(
      ["use", "Ven001"],
      [Response.json({ venues: [{ ...venue, id: "Other1" }] }), Response.json({ venue, slots: [], assignments: [], myUpcomingShifts: [] })],
    );
    await expect(venueCli.run(ctx)).rejects.toThrow('Venue "Ven001" is ambiguous. Use one of: Other1, Ven001');
    expect(paths).toEqual(["/api/venue/venues?limit=100&offset=0&q=Ven001", "/api/venue/venues/Ven001/dashboard"]);
  });
});

describe("cld venue sections update", () => {
  test("sends only the fields that were passed", () => {
    expect(buildSectionPatch({ ...none, title: "Winter hours" })).toEqual({ title: "Winter hours" });
    expect(buildSectionPatch({ ...none, content: { text: "Closed on Friday" } })).toEqual({ content: { text: "Closed on Friday" } });
    expect(buildSectionPatch({ ...none, position: 0 })).toEqual({ position: 0 });
  });

  test("changes visibility only with --enabled or --disabled", () => {
    expect(buildSectionPatch({ ...none, title: "Draft" })).not.toHaveProperty("enabled");
    expect(buildSectionPatch({ enabled: false, disabled: true })).toEqual({ enabled: false });
    expect(buildSectionPatch({ enabled: true, disabled: false })).toEqual({ enabled: true });
    expect(() => buildSectionPatch({ enabled: true, disabled: true })).toThrow("Pass only one of --enabled or --disabled.");
  });

  test("refuses an update without changes", () => {
    expect(() => buildSectionPatch(none)).toThrow("Nothing to update.");
  });
});

const cliHome = await mkdtemp(join(tmpdir(), "cld-venue-cli-"));
await installFirstPartyModules(cliHome, ["venue"]);
afterAll(() => rm(cliHome, { recursive: true, force: true }));
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test.each(["get", "shifts list"])("%s links only the caller's assignments", async (command) => {
  const venue = { id: "Venue1", name: "Venue", slug: "venue" };
  const own = { id: "Own001", venueId: venue.id, userId: "caller", userDisplayName: "Caller" };
  const foreign = { id: "Other1", venueId: venue.id, userId: "other", userDisplayName: "Other" };
  const slot = {
    template: { id: "Templ1", title: "Morning", date: null, startTime: "09:00", endTime: "10:00" },
    date: "2026-10-21",
    assignedCount: 2,
    missingPeople: 0,
    full: true,
    assignments: [own, foreign],
  };
  const dashboard = { venue, slots: [slot], assignments: [own, foreign], myUpcomingShifts: [own] };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/venue/venues") return Response.json({ venues: [venue] });
      if (path === `/api/venue/venues/${venue.id}/dashboard`) return Response.json(dashboard);
      return Response.json({ message: "unexpected" }, { status: 500 });
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "../cloud-cli/src/index.ts",
      "--server",
      base,
      "--token",
      "test-token",
      "--json",
      "venue",
      ...command.split(" "),
      venue.id,
    ],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, XDG_CONFIG_HOME: cliHome, CLD_LOCALE: "en" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(exitCode, stderr).toBe(0);
  const linkedOwn = { ...own, permalink: `${base}/open/venue.assignment/~${own.id}` };
  const linkedSlots = [{ ...slot, assignments: [linkedOwn, foreign] }];
  expect(JSON.parse(stdout)).toEqual(
    command === "shifts list"
      ? { items: linkedSlots }
      : {
          ...dashboard,
          venue: { ...venue, permalink: `${base}/open/venue.venue/~${venue.id}` },
          slots: linkedSlots,
          assignments: [linkedOwn, foreign],
          myUpcomingShifts: [linkedOwn],
        },
  );
});
