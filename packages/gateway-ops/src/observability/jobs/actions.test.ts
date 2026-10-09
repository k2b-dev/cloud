import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { runScheduleNowAction } from "./actions";
import { jobsObservabilityService } from "./service";

const runNow = spyOn(jobsObservabilityService, "runScheduleNow");
afterEach(() => runNow.mockReset());

const submit = async (redirectTo: string) => {
  runNow.mockResolvedValue(
    ok({ message: "Schedule run accepted", schedulerId: "s", scheduleId: "nightly", acceptedAt: "2026-10-09T00:00:00.000Z" }),
  );
  const app = new Hono<AuthContext>().post("/run-now", runScheduleNowAction);
  const body = new URLSearchParams({ redirectTo, appId: "a", schedulerId: "s", scheduleId: "nightly" });
  const response = await app.request("/run-now", { method: "POST", body });
  expect(response.status).toBe(303);
  return response.headers.get("location") ?? "";
};

describe("run-now action", () => {
  test("returns to the submitted Cloud page", async () => {
    expect(await submit("/admin/observability/jobs?app=a")).toStartWith("/admin/observability/jobs?app=a&job_action=accepted");
  });

  test("never returns to another host, whatever the dot segments resolve to", async () => {
    for (const target of ["//evil.example/x", "/.//evil.example//other.example/x", "/admin/..//evil.example", "https://evil.example"]) {
      expect(await submit(target)).toStartWith("/admin/observability/jobs?job_action=accepted");
    }
  });
});
