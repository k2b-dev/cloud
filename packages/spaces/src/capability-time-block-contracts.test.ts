import { expect, test } from "bun:test";
import { CAPABILITY_MAX_RESULT_BYTES, capabilityResultSchema } from "@k2b/cloud/contracts";
import {
  TimeBlockCreateInputSchema,
  TimeBlockDataSchema,
  TimeBlockDeleteInputSchema,
  TimeBlockListDataSchema,
  TimeBlockListInputSchema,
  TimeBlockUpdateInputSchema,
} from "./capability-time-block-contracts";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const from = "2026-10-23T08:00:00Z";
const to = "2026-10-23T09:00:00Z";
const revision = "a".repeat(64);

test("time blocks require UUID create identity and ordered ISO instants", () => {
  const input = { id, itemId: "Item01", taskTitle: "Plan release", startsAt: from, endsAt: to };
  expect(TimeBlockCreateInputSchema.parse(input)).toEqual(input);
  for (const change of [
    { id: "Item01" },
    { id: undefined },
    { startsAt: "2026-10-23" },
    { endsAt: from },
    { endsAt: "2026-10-23T07:00:00Z" },
    { title: "Task-owned initial title" },
  ])
    expect(TimeBlockCreateInputSchema.safeParse({ ...input, ...change }).success).toBeFalse();
});

test("time-block mutations require exact read revision and preserve omitted fields", () => {
  expect(TimeBlockUpdateInputSchema.parse({ id, revision, title: "Focused work" })).toEqual({ id, revision, title: "Focused work" });
  expect(TimeBlockUpdateInputSchema.safeParse({ id, revision }).success).toBeFalse();
  expect(TimeBlockUpdateInputSchema.safeParse({ id, title: "Focused work" }).success).toBeFalse();
  expect(TimeBlockUpdateInputSchema.safeParse({ id, revision, ownerId: id, title: "Focused work" }).success).toBeFalse();
  expect(TimeBlockDeleteInputSchema.safeParse({ id }).success).toBeFalse();
  expect(TimeBlockDeleteInputSchema.safeParse({ id, revision }).success).toBeTrue();
});

test("time-block list bounds come from calendar contract and escaped JSON envelope budget", () => {
  expect(TimeBlockListInputSchema.parse({ from, to })).toEqual({ from, to, mine: false, limit: 25 });
  expect(TimeBlockListInputSchema.parse({ itemId: "Item01" })).toEqual({ itemId: "Item01", mine: false, limit: 25 });
  expect(TimeBlockListInputSchema.safeParse({ itemId: "Item01", from, to }).success).toBeTrue();
  for (const input of [
    {},
    { itemId: "Item01", from },
    { itemId: "Item01", to },
    { itemId: "Item01", from, to: from },
    { itemId: "not-a-public-id" },
    { from, to: from },
    { from, to: "2028-10-23T09:00:00Z" },
    { from, to, limit: 51 },
  ])
    expect(TimeBlockListInputSchema.safeParse(input).success).toBeFalse();
  const block = TimeBlockDataSchema.parse({
    id,
    itemId: "Item01",
    spaceId: "Space1",
    title: "\u0001".repeat(200),
    ownerId: id,
    ownerName: "\u0001".repeat(200),
    spaceName: "\u0001".repeat(100),
    spaceColor: "\u0001".repeat(100),
    startsAt: from,
    endsAt: to,
    taskState: "no_access",
    canWrite: false,
    canDelete: false,
    revision,
    presentationTruncated: false,
  });
  const envelope = { data: Array.from({ length: 50 }, () => block), page: { hasMore: true, nextCursor: "c".repeat(256) } };
  expect(capabilityResultSchema(TimeBlockListDataSchema).safeParse(envelope).success).toBeTrue();
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
});
