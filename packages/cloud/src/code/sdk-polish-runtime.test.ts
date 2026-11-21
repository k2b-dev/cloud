import { expect, test } from "bun:test";
import type { CodeContext } from "./authoring-types";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";

const runtime = async (manifest = sdkFixture(), resource = false) => {
  const sdk = generateCodeSdk(
    [manifest],
    resource
      ? { mode: "resource", owner: { kind: "resource", ref: { type: `${manifest.appId}.workshop`, id: "w" } } }
      : { mode: "personal" },
  );
  return import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
};

test("omitting an optional input sends the same empty object as the legacy call", async () => {
  const sdk = await runtime();
  const inputs: unknown[] = [];
  sdk.__codeSdk.bind({
    call: async (_: string, value: unknown) => {
      inputs.push(value);
      return { data: [] };
    },
  });
  await sdk.work_shop.catalog.list();
  await sdk.work_shop.catalog.list({});
  expect(inputs[0]).toEqual(inputs[1]);
  await expect(sdk.work_shop.catalog.list(null)).rejects.toMatchObject({ code: "code_sdk_invalid_input" });
});

test("all route overloads expose the actual request path and method and preserve legacy options", async () => {
  const sdk = await runtime(sdkFixture("routes"));
  for (const method of ["get", "post", "put", "delete", "all"]) {
    const handler = (c: CodeContext) => c.json({ path: c.req.path, method: c.req.method, url: c.req.raw.url });
    sdk.app[method](`/${method}`, { public: true, layout: "plain" }, handler);
    sdk.app[method](`/old-${method}`, handler, { public: true, layout: "plain" });
  }
  expect(
    sdk.__codeSdk
      .entries()
      .every((entry: { route: { public: boolean; layout: string } }) => entry.route.public && entry.route.layout === "plain"),
  ).toBe(true);
  const response = await sdk.__codeSdk.run("route:POST:/post", {
    path: "/post",
    method: "POST",
    query: "?a=1",
    params: {},
    contentType: "text/plain",
    body: "hello",
  });
  expect(JSON.parse(response.body)).toEqual({ path: "/post", method: "POST", url: "https://code.invalid/post?a=1" });
});

test("decision aliases preserve the wire protocol and existing response fields", async () => {
  const manifest = sdkFixture("core");
  const query = manifest.queries.find((query) => query.localId === "catalog.list")!;
  manifest.queries = [{ ...query, localId: "ai.decide" }];
  manifest.actions = [];
  manifest.events = [];
  const sdk = await runtime(manifest);
  const calls: Array<{ call: { input: unknown } }> = [];
  sdk.__codeSdk.bind({
    call: async (_: string, value: { call: { input: unknown } }) => {
      calls.push(value);
      return {
        data: {
          answers: {
            yes: { type: "noul", probability: 0.9, value: true },
            category: { type: "choice", choice: "one", confidence: 0.8, probabilities: {} },
          },
          model: { id: "test" },
        },
      };
    },
  });
  const questions = { yes: { type: "boolean", instructions: "Relevant?" } };
  const answer = await sdk.core.ai.decide({ task: "triage", input: { title: "Title" }, questions });
  expect(calls[0]?.call.input).toEqual({
    task: "triage",
    state: { title: "Title" },
    questions: { yes: { type: "noul", instructions: "Relevant?" } },
  });
  expect(questions.yes.type).toBe("boolean");
  expect(answer.data.answers.yes).toEqual({ type: "noul", probability: 0.9, confidence: 0.9, value: true });
  expect(answer.data.answers.category).toEqual({ type: "choice", choice: "one", confidence: 0.8, probabilities: {} });
  await sdk.core.ai.decide({
    task: "old",
    state: { old: true },
    input: { ignored: true },
    questions: { yes: { type: "noul", instructions: "Relevant?" } },
  });
  expect(calls[1]?.call.input).toEqual({
    task: "old",
    state: { old: true },
    questions: { yes: { type: "noul", instructions: "Relevant?" } },
  });
});

test("event callbacks retain their existing envelope fields", async () => {
  const manifest = sdkFixture("events");
  manifest.events = manifest.events?.map((event) => ({ ...event, place: "workshop" }));
  const sdk = await runtime(manifest, true);
  let received: unknown;
  sdk.app.on("events.changed", (event: unknown) => {
    received = event;
  });
  const input = { id: "e1", type: "events.changed", version: 1, data: { title: "Changed" }, place: { type: "events.workshop", id: "w" } };
  await sdk.__codeSdk.run("event:events.changed@1", input);
  expect(received).toBe(input);
});
