import { expect, test } from "bun:test";
import { generateSpecs } from "hono-openapi";
import { z } from "zod";
import spacesApi from ".";

const OperationSchema = z.object({ responses: z.record(z.string(), z.unknown()) });

test("the calendar routes publish their errors, with 503 for a catalog that is unreachable for now", async () => {
  const spec = z.object({ paths: z.record(z.string(), z.record(z.string(), OperationSchema)) }).parse(await generateSpecs(spacesApi));
  expect(Object.keys(spec.paths["/calendar/sources"]?.get?.responses ?? {}).sort()).toEqual(["200", "403", "503"]);
  expect(Object.keys(spec.paths["/calendar/events"]?.get?.responses ?? {}).sort()).toEqual(["200", "400", "403"]);
});
