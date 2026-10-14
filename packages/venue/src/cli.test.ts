import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFirstPartyModules } from "../../cloud-cli/test/fixtures/first-party";
import { buildSectionPatch } from "./cli";

const none = { enabled: false, disabled: false };

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
