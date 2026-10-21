import { expect, mock, spyOn, test } from "bun:test";
import * as evaluator from "./alert-evaluator";
import { fanoutPendingBaseNotices } from "./alert-runtime";
import * as notices from "./base-notifications";
import * as freshness from "./source-freshness";
import * as sqlService from "./sql-service";

const claim = {
  id: "rule-one",
  short_id: "Rule01",
  base_id: "base-one",
  name: "One",
  revision: 1,
  lease_id: "lease-one",
  reset_generation: 0,
  comparison: "above" as const,
  warn: 80,
  critical: null,
  min_duration_seconds: 0,
  interval_seconds: 300,
  overdue: false,
  next_check_at: new Date("2026-10-21T12:00:00Z"),
  claimed_at: new Date("2026-10-21T12:00:00Z"),
};

test("recipient scans advance past empty admin pages but stop when the durable outbox is idle", async () => {
  const page = spyOn(notices, "fanoutBaseNotices").mockResolvedValueOnce(0).mockResolvedValueOnce(2).mockResolvedValueOnce(null);
  const heartbeat = mock(async () => {});
  try {
    expect(await fanoutPendingBaseNotices({ signal: new AbortController().signal, heartbeat })).toEqual({ recipients: 2 });
    expect(page).toHaveBeenCalledTimes(3);
    expect(heartbeat).toHaveBeenCalledTimes(3);
  } finally {
    page.mockRestore();
  }
});

test("an evaluator failure waits for already running sibling work before the scheduler can retry", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof sqlService.runAlertSql>>>();
  const failed = Promise.withResolvers<void>();
  const take = spyOn(evaluator, "claimDueAlert")
    .mockResolvedValueOnce(claim)
    .mockResolvedValueOnce({ ...claim, id: "rule-two" })
    .mockResolvedValue(null);
  const apply = spyOn(evaluator, "applyAlertEvaluation").mockResolvedValue(true);
  const run = spyOn(sqlService, "runAlertSql").mockImplementation(async (input) => {
    if (input.ruleId === "rule-one") return pending.promise;
    failed.resolve();
    throw new Error("Fixture SQL transport failed");
  });
  let settled = false;
  const evaluation = evaluator.evaluateDueAlerts("en", { now: () => new Date("2026-10-21T12:00:00Z") });
  const observed = evaluation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await failed.promise;
    // A turn boundary drains the rejection microtasks, without a timing delay.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    pending.resolve({ ok: false, error: { code: "SQL_ERROR", message: "Fixture failure", status: 400 } });
    await expect(evaluation).rejects.toThrow("Pulse alert evaluation failed");
    expect(apply).toHaveBeenCalledTimes(1);
  } finally {
    pending.resolve({ ok: false, error: { code: "SQL_ERROR", message: "Fixture failure", status: 400 } });
    await observed;
    take.mockRestore();
    apply.mockRestore();
    run.mockRestore();
  }
});

test("recipient scans bound pages, stop on cancellation and await lease renewal before new work", async () => {
  const page = spyOn(notices, "fanoutBaseNotices").mockResolvedValue(1);
  const abort = new AbortController();
  try {
    expect(await fanoutPendingBaseNotices({ signal: abort.signal, heartbeat: async () => {} })).toEqual({ recipients: 20 });
    expect(page).toHaveBeenCalledTimes(20);
    page.mockClear();
    await expect(
      fanoutPendingBaseNotices({
        signal: abort.signal,
        heartbeat: async () => {
          throw new Error("lease lost");
        },
      }),
    ).rejects.toThrow("lease lost");
    expect(page).not.toHaveBeenCalled();
    abort.abort();
    expect(await fanoutPendingBaseNotices({ signal: abort.signal, heartbeat: async () => {} })).toEqual({ recipients: 0 });
    expect(page).not.toHaveBeenCalled();
  } finally {
    page.mockRestore();
  }
});

for (const seam of ["before", "heartbeat", "locale", "claim"] as const) {
  test(`alert cancellation at ${seam} starts no SQL or domain update`, async () => {
    const abort = new AbortController();
    const take = spyOn(evaluator, "claimDueAlert").mockImplementation(async () => {
      abort.abort();
      return claim;
    });
    const language = spyOn(notices, "notificationLocale").mockImplementation(async () => {
      if (seam === "locale") abort.abort();
      return "en";
    });
    const run = spyOn(sqlService, "runAlertSql");
    const apply = spyOn(evaluator, "applyAlertEvaluation");
    const release = spyOn(evaluator, "releaseCancelledAlert").mockResolvedValue(undefined);
    try {
      if (seam === "before") abort.abort();
      const result = await evaluator.evaluateDueAlerts("en", {
        signal: abort.signal,
        now: () => claim.claimed_at,
        heartbeat: async () => {
          if (seam === "heartbeat") abort.abort();
        },
      });
      expect(result.applied).toBe(0);
      expect(run).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      if (seam === "claim") {
        expect(take).toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(take.mock.calls.length);
      } else {
        expect(take).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
      }
      if (seam === "before" || seam === "heartbeat") expect(language).not.toHaveBeenCalled();
    } finally {
      take.mockRestore();
      language.mockRestore();
      run.mockRestore();
      apply.mockRestore();
      release.mockRestore();
    }
  });
}

for (const outcome of ["result", "abort rejection", "genuine rejection"] as const) {
  test(`cancelled SQL ${outcome} releases the claim without applying a domain error`, async () => {
    const abort = new AbortController();
    const take = spyOn(evaluator, "claimDueAlert").mockResolvedValueOnce(claim).mockResolvedValue(null);
    const release = spyOn(evaluator, "releaseCancelledAlert").mockResolvedValue(undefined);
    const apply = spyOn(evaluator, "applyAlertEvaluation");
    const failure = new Error("Fixture transport failure");
    const run = spyOn(sqlService, "runAlertSql").mockImplementation(async () => {
      abort.abort();
      if (outcome === "abort rejection") throw abort.signal.reason;
      if (outcome === "genuine rejection") throw failure;
      return { ok: false, error: { code: "CANCELLED", message: "Cancelled", status: 400 } };
    });
    try {
      const evaluation = evaluator.evaluateDueAlerts("en", { signal: abort.signal, now: () => claim.claimed_at });
      if (outcome === "genuine rejection") {
        await expect(evaluation).rejects.toMatchObject({ errors: [failure] });
      } else {
        expect(await evaluation).toEqual({ attempted: 1, applied: 0 });
      }
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(claim);
      expect(apply).not.toHaveBeenCalled();
    } finally {
      take.mockRestore();
      release.mockRestore();
      apply.mockRestore();
      run.mockRestore();
    }
  });
}

test("locale failure cannot strand an alert claim", async () => {
  const language = spyOn(notices, "notificationLocale").mockRejectedValue(new Error("Fixture settings unavailable"));
  const take = spyOn(evaluator, "claimDueAlert");
  try {
    await expect(evaluator.evaluateDueAlerts()).rejects.toThrow("Pulse alert evaluation failed");
    expect(take).not.toHaveBeenCalled();
  } finally {
    language.mockRestore();
    take.mockRestore();
  }
});

test("recipient cancellation during heartbeat starts no fanout page", async () => {
  const abort = new AbortController();
  const page = spyOn(notices, "fanoutBaseNotices");
  try {
    expect(
      await fanoutPendingBaseNotices({
        signal: abort.signal,
        heartbeat: async () => {
          abort.abort();
        },
      }),
    ).toEqual({ recipients: 0 });
    expect(page).not.toHaveBeenCalled();
  } finally {
    page.mockRestore();
  }
});

for (const seam of ["heartbeat", "locale"] as const) {
  test(`freshness cancellation during ${seam} starts no batch`, async () => {
    const abort = new AbortController();
    const language = spyOn(notices, "notificationLocale").mockImplementation(async () => {
      abort.abort();
      return "en";
    });
    const batch = spyOn(freshness, "checkSourceFreshnessBatch");
    try {
      expect(
        await freshness.checkSourceFreshness("en", {
          now: claim.claimed_at,
          signal: abort.signal,
          heartbeat: async () => {
            if (seam === "heartbeat") abort.abort();
          },
        }),
      ).toEqual({ checked: 0 });
      expect(batch).not.toHaveBeenCalled();
      if (seam === "heartbeat") expect(language).not.toHaveBeenCalled();
    } finally {
      language.mockRestore();
      batch.mockRestore();
    }
  });
}
