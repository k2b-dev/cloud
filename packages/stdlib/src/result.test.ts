import { describe, it, expect, expectTypeOf } from "bun:test";
import { ok, okMany, fail, err, paginate, unwrap, isServiceError, tryCatch } from "./result";
import type { Result, ServiceError, ServiceErrorCode } from "./index";

// ==========================
// ok()
// ==========================

describe("ok()", () => {
  it("creates void success result", () => {
    const result = ok();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeUndefined();
  });

  it("creates success result with data", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(42);
  });

  it("creates success result with falsy data", () => {
    expect(ok(0).ok && ok(0)).toMatchObject({ ok: true, data: 0 });
    expect(ok("").ok && ok("")).toMatchObject({ ok: true, data: "" });
    expect(ok(false).ok && ok(false)).toMatchObject({ ok: true, data: false });
  });

  it("preserves null as data", () => {
    const result = ok(null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });
});

// ==========================
// okMany
// ==========================

describe("okMany", () => {
  it("creates paginated success with hasNext=true when more pages", () => {
    const result = okMany([1, 2], { page: 1, perPage: 2, total: 5 });
    if (result.ok) {
      expect(result.data.hasNext).toBe(true);
      expect(result.data.items).toEqual([1, 2]);
    }
  });

  it("creates paginated success with hasNext=false on last page", () => {
    const result = okMany([5], { page: 3, perPage: 2, total: 5 });
    if (result.ok) expect(result.data.hasNext).toBe(false);
  });

  it("works with empty items array", () => {
    const result = okMany([], { page: 1, perPage: 10, total: 0 });
    if (result.ok) {
      expect(result.data.items).toEqual([]);
      expect(result.data.hasNext).toBe(false);
    }
  });
});

// ==========================
// fail
// ==========================

describe("fail", () => {
  it("creates error result", () => {
    const result = fail(err.notFound("User"));
    expect(result.ok).toBe(false);
  });

  it("preserves error properties", () => {
    const result = fail(err.badInput("bad"));
    if (!result.ok) {
      expect(result.error.code).toBe("BAD_INPUT");
      expect(result.error.message).toBe("bad");
      expect(result.error.status).toBe(400);
    }
  });
});

// ==========================
// err helpers
// ==========================

describe("err helpers", () => {
  it("badInput has code BAD_INPUT and status 400", () => {
    const e = err.badInput("oops");
    expect(e.code).toBe("BAD_INPUT");
    expect(e.status).toBe(400);
    expect(e.message).toBe("oops");
  });

  it("unauthenticated uses default message when none given", () => {
    expect(err.unauthenticated().message).toBe("Authentication required");
  });

  it("forbidden uses default message when none given", () => {
    expect(err.forbidden().message).toBe("Insufficient permissions");
  });

  it("notFound appends 'not found'", () => {
    expect(err.notFound("User").message).toBe("User not found");
  });

  it("conflict takes its sentence as given and appends nothing", () => {
    expect(err.conflict("Email already exists").message).toBe("Email already exists");
    expect(err.conflict("Task changed; read it and retry").message).toBe("Task changed; read it and retry");
    expect(err.conflict("Email").message).toBe("Email");
  });

  it("internal uses default message when none given", () => {
    expect(err.internal().message).toBe("Internal server error");
  });

  it("creates unavailable and tooManyRequests errors with default or custom messages", () => {
    expect(err.unavailable()).toEqual({ code: "UNAVAILABLE", message: "Service unavailable", status: 503 });
    expect(err.unavailable("Draft reads unavailable").message).toBe("Draft reads unavailable");
    expect(err.tooManyRequests()).toEqual({ code: "TOO_MANY_REQUESTS", message: "Too many requests", status: 429 });
    expect(err.tooManyRequests("Try again later").message).toBe("Try again later");
  });

  it("preserves the public status union and factory literals", () => {
    expectTypeOf<ServiceError["status"]>().toEqualTypeOf<400 | 401 | 403 | 404 | 405 | 406 | 408 | 409 | 410 | 412 | 413 | 415 | 416 | 421 | 422 | 429 | 500 | 501 | 502 | 503 | 504>();
    expectTypeOf(err.unavailable()).toEqualTypeOf<{ code: "UNAVAILABLE"; message: string; status: 503 }>();
    expectTypeOf(err.tooManyRequests()).toEqualTypeOf<{ code: "TOO_MANY_REQUESTS"; message: string; status: 429 }>();
    expectTypeOf<"UNAVAILABLE" | "TOO_MANY_REQUESTS">().toExtend<ServiceErrorCode>();

    const unavailable = { code: "READ_UNAVAILABLE", message: "Read failed", status: 503 } satisfies ServiceError;
    const limited = { code: "READ_LIMITED", message: "Try later", status: 429 } satisfies ServiceError;
    const consumerErrors = ([413, 422, 502, 504] as const).map(status => ({ code: "DOMAIN_ERROR", message: "Failed", status } satisfies ServiceError));
    expect(consumerErrors.map(error => fail(error).ok)).toEqual([false, false, false, false]);
    const results: Result[] = [fail(unavailable), fail(limited)];
    expect(results).toEqual([{ ok: false, error: unavailable }, { ok: false, error: limited }]);
  });

  it("each helper has correct status code", () => {
    const cases: [() => ServiceError, ServiceError["status"]][] = [
      [() => err.badInput("x"), 400],
      [() => err.unauthenticated(), 401],
      [() => err.forbidden(), 403],
      [() => err.notFound("x"), 404],
      [() => err.conflict("x"), 409],
      [() => err.internal(), 500],
      [() => err.unavailable(), 503],
      [() => err.tooManyRequests(), 429],
    ];
    for (const [factory, status] of cases) {
      expect(factory().status).toBe(status);
    }
  });
});

// ==========================
// paginate
// ==========================

describe("paginate", () => {
  it("returns defaults when no params given", () => {
    expect(paginate()).toEqual({ page: 1, perPage: 20, offset: 0 });
  });

  it("calculates correct offset", () => {
    expect(paginate({ page: 3, perPage: 10 })).toEqual({ page: 3, perPage: 10, offset: 20 });
  });

  it("handles page 1 explicitly", () => {
    expect(paginate({ page: 1, perPage: 5 })).toEqual({ page: 1, perPage: 5, offset: 0 });
  });

  it("clamps negative page to 1", () => {
    expect(paginate({ page: -1, perPage: 10 })).toEqual({ page: 1, perPage: 10, offset: 0 });
  });

  it("clamps zero perPage to 1", () => {
    expect(paginate({ page: 1, perPage: 0 })).toEqual({ page: 1, perPage: 1, offset: 0 });
  });
});

// ==========================
// unwrap
// ==========================

describe("unwrap", () => {
  it("returns data from ok result", () => {
    expect(unwrap(ok(42))).toBe(42);
  });

  it("throws error from fail result", () => {
    expect(() => unwrap(fail(err.notFound("x")))).toThrow();
  });

  it("thrown error is the ServiceError object", () => {
    try {
      unwrap(fail(err.notFound("x")));
    } catch (e: any) {
      expect(e.code).toBe("NOT_FOUND");
      expect(e.status).toBe(404);
    }
  });
});

// ==========================
// isServiceError
// ==========================

describe("isServiceError", () => {
  it("returns true for valid ServiceError shape", () => {
    for (const status of [400, 401, 403, 404, 405, 406, 408, 409, 410, 412, 413, 415, 416, 421, 422, 429, 499, 500, 501, 502, 503, 504]) {
      expect(isServiceError({ code: "DOMAIN_ERROR", message: "y", status })).toBe(true);
    }
  });

  it("keeps the historical numeric shape check without restricting statuses", () => {
    for (const status of [200, 418, 529, 599, -1, 400.5, NaN, Infinity]) {
      expect(isServiceError({ code: "X", message: "y", status })).toBe(true);
    }
    for (const status of ["503", undefined, null]) {
      expect(isServiceError({ code: "X", message: "y", status })).toBe(false);
    }
  });

  it("returns false for null", () => {
    expect(isServiceError(null)).toBe(false);
  });

  it("returns false for plain string", () => {
    expect(isServiceError("error")).toBe(false);
  });

  it("returns false for object missing code", () => {
    expect(isServiceError({ message: "y", status: 400 })).toBe(false);
  });

  it("returns false for object with wrong types", () => {
    expect(isServiceError({ code: 123, message: "y", status: 400 })).toBe(false);
  });
});

// ==========================
// tryCatch
// ==========================

describe("tryCatch", () => {
  it("wraps successful async result in ok", async () => {
    const result = await tryCatch(() => Promise.resolve(42));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(42);
  });

  it("wraps thrown ServiceError in fail preserving error", async () => {
    const result = await tryCatch(() => {
      throw err.notFound("X");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("preserves transient service errors through fail, unwrap and tryCatch", async () => {
    for (const error of [err.unavailable(), err.tooManyRequests(), { code: "READ_UNAVAILABLE", message: "Retry", status: 503 } satisfies ServiceError]) {
      const result = await tryCatch(async () => unwrap(fail(error)));
      expect(result).toMatchObject({ ok: false, error });
    }
  });

  it("preserves existing consumer error statuses without invoking the mapper", async () => {
    const errors = [413, 422, 429, 499, 502, 503, 504, 529].map(status => ({ code: "DOMAIN_ERROR", message: "Retry", status }));
    for (const error of errors) {
      let mapped = false;
      const result = await tryCatch(async () => { throw error; }, () => {
        mapped = true;
        return err.internal();
      });
      expect(mapped).toBe(false);
      if (result.ok) throw new Error("Expected failure");
      expect(result.error === error).toBe(true);
    }
  });

  it("wraps thrown Error using internal by default", async () => {
    const result = await tryCatch(() => {
      throw new Error("boom");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toBe("boom");
    }
  });

  it("uses custom onError mapper when provided", async () => {
    const result = await tryCatch(
      () => { throw "x"; },
      () => err.badInput("custom"),
    );
    if (!result.ok) expect(result.error.code).toBe("BAD_INPUT");
  });

  it("wraps non-Error throw via String()", async () => {
    const result = await tryCatch(() => { throw 42; });
    if (!result.ok) expect(result.error.message).toContain("42");
  });

  // Regression: onError throwing must not break the never-throws contract.
  it("never throws even when onError itself throws", async () => {
    const result = await tryCatch(
      async () => {
        throw new Error("boom");
      },
      () => {
        throw new Error("mapping crashed");
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
    }
  });
});

// ==========================
// paginate (regression)
// ==========================

describe("paginate (regression)", () => {
  it("coerces NaN/Infinity to defaults", () => {
    const r = paginate({ page: NaN as any, perPage: Infinity as any });
    expect(Number.isFinite(r.page)).toBe(true);
    expect(Number.isFinite(r.perPage)).toBe(true);
    expect(Number.isFinite(r.offset)).toBe(true);
  });

  it("clamps oversize perPage to a sane maximum", () => {
    const r = paginate({ page: 1, perPage: 1_000_000 });
    expect(r.perPage).toBeLessThanOrEqual(1000);
  });

  it("floors fractional values", () => {
    const r = paginate({ page: 2.7, perPage: 10.9 });
    expect(r.page).toBe(2);
    expect(r.perPage).toBe(10);
  });

  it("rejects negative values via Math.max(1, ...)", () => {
    const r = paginate({ page: -5, perPage: -10 });
    expect(r.page).toBe(1);
    expect(r.perPage).toBe(1);
  });
});
