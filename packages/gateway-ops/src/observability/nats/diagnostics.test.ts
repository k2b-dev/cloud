import { expect, test } from "bun:test";
import { NatsQuerySchema, selectNatsStreams } from "./diagnostics";
import type { NatsInventorySummary, NatsStream } from "./service";

const stream = (name: string, owner = "mail", problem = false): NatsStream => ({
  name,
  kind: "stream",
  storage: "file",
  messages: problem ? 1 : 0,
  bytes: 0,
  consumers: 0,
  replicas: 1,
  maxBytes: -1,
  maxMessages: -1,
  maxAgeMs: 0,
  deadLetter: problem,
  cluster: null,
  sync: { namespace: "dev", owner, kind: "queue", id: `job-${name}` },
});
const snapshot = (streams: NatsStream[]): NatsInventorySummary => ({
  status: "available",
  streams,
  total: streams.length,
  sampledAt: "now",
});
test("filters across the complete scan before paging and prioritizes problems", () => {
  const data = snapshot([stream("a"), stream("b", "core"), stream("c", "mail", true), stream("d")]);
  const query = NatsQuerySchema.parse({ app: "mail", namespace: "dev", resource: "JOB", limit: 1 });
  const first = selectNatsStreams(data, query);
  expect(first.streams.map((value) => value.name)).toEqual(["c"]);
  expect(first).toMatchObject({
    total: 3,
    matchedTotal: 3,
    accountTotal: 4,
    nextOffset: 1,
    summary: { problemStreams: 1, deadLetterStreams: 1 },
  });
  expect(selectNatsStreams(data, { ...query, offset: 1 }).streams[0]?.name).toBe("a");
  expect(selectNatsStreams(data, { ...query, problems: "true" }).total).toBe(1);
});
test("partial scan exposes only known matches and never an authoritative empty result", () => {
  const data = { ...snapshot([stream("a")]), status: "partial" as const, total: 50 };
  expect(selectNatsStreams(data, NatsQuerySchema.parse({ app: "absent" }))).toMatchObject({
    total: 0,
    matchedTotal: null,
    accountTotal: 50,
    scannedTotal: 1,
  });
});
test("invalid paging and wildcard consumer subjects are rejected", () => {
  for (const value of [{ offset: -1 }, { limit: 101 }, { problems: "yes" }, { stream: "foo.*" }, { consumerOffset: 0.5 }])
    expect(NatsQuerySchema.safeParse(value).success).toBe(false);
});
