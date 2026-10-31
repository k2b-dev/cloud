import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CapabilityExecution } from "@k2b/cloud/capabilities/store";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "capability-detail-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Detail } = await import("./ExecutionDetail");

const execution: CapabilityExecution = {
  id: "6c0f7b6e-6f5e-4a44-8f0f-2f1d0a4b7c11",
  requestId: "req-full-correlation-id",
  origin: "assistant",
  appId: "contacts",
  capability: "contacts.delete",
  kind: "action",
  destructive: true,
  actorKind: "user",
  actorId: "actor-full-id",
  userId: "5de41b38-a3ac-47f3-b47c-da6472afbb42",
  accessSubjectType: "service_account",
  accessSubjectId: "subject-full-id",
  status: "failed",
  errorCode: "CAPABILITY_FAILED",
  inputMeta: { type: "object", keys: ["contactId", "<script>"], omittedKeys: 4 },
  outputMeta: { type: "array", length: 3 },
  idempotencyKey: "idem-full-key",
  replayed: false,
  startedAt: "2026-09-08T12:00:00.000Z",
  completedAt: "2026-09-08T12:00:07.000Z",
  durationMs: 7000,
};

test("execution detail shows correlation, shape and the user's AI usage without leaking payloads", () => {
  const html = renderToString(() =>
    createComponent(Detail, {
      executions: [execution],
      closeHref: "/admin/observability/capabilities?app=contacts",
    }),
  );

  for (const value of [
    "req-full-correlation-id",
    "actor-full-id",
    "subject-full-id",
    "CAPABILITY_FAILED",
    "idem-full-key",
    "contacts.delete",
    "k2b-detail-panel",
  ])
    expect(html).toContain(value);
  // Shape metadata renders as size and key names only.
  expect(html).toContain("contactId");
  expect(html).toContain("+4 more");
  expect(html).toContain("3 items");
  expect(html).toContain("&lt;script");
  expect(html).not.toContain("<script>");
  expect(html).toContain("/admin/ai?sec=usage");
  expect(html).toContain("5de41b38-a3ac-47f3-b47c-da6472afbb42");
  expect(html).toContain("/admin/observability/capabilities?app=contacts");
  // K1 outline: kind line with the call's state, properties, then identifiers under "More about this call".
  const kind = html.slice(html.indexOf('class="k2b-detail-panel__kind"'), html.indexOf("<h2>"));
  expect(kind).toContain("Capability call");
  expect(kind).toContain("Failed");
  expect(html).toContain("<h2>contacts · contacts.delete</h2>");
  expect(html).not.toContain("k2b-detail-panel__section-icon");
  const properties = html.indexOf(">Properties<");
  const more = html.indexOf("More about this call");
  expect(properties).toBeGreaterThan(-1);
  expect(properties).toBeLessThan(more);
  expect(html.slice(more)).toContain("req-full-correlation-id");
  expect(html.slice(more)).toContain("idem-full-key");
});

test("execution detail lists several calls of one request as their own sections", () => {
  const retry: CapabilityExecution = { ...execution, id: "retry-id", status: "succeeded", errorCode: null, idempotencyKey: "idem-retry" };
  const html = renderToString(() =>
    createComponent(Detail, {
      executions: [execution, retry],
      closeHref: "/admin/observability/capabilities?app=contacts",
    }),
  );

  expect(html).toContain("<h2>2 calls</h2>");
  expect(html.match(/contacts · contacts\.delete/g)?.length).toBeGreaterThanOrEqual(2);
  expect(html).toContain("Failed");
  expect(html).toContain("Succeeded");
  expect(html).toContain("idem-full-key");
  expect(html).toContain("idem-retry");
  expect(html).not.toContain(">Properties<");
});

test("execution detail identifies an app actor and its enrolled key without a person", () => {
  const html = renderToString(() =>
    createComponent(Detail, {
      executions: [
        {
          ...execution,
          origin: "app",
          actorKind: "app",
          actorId: null,
          userId: null,
          actorAppId: "vendor-web",
          actorKeyId: "22222222-2222-4222-8222-222222222222",
          accessSubjectType: null,
          accessSubjectId: null,
        },
      ],
      closeHref: "/admin/observability/capabilities",
    }),
  );
  expect(html).toContain("vendor-web");
  expect(html).toContain("App key ID");
  expect(html).toContain("22222222-2222-4222-8222-222222222222");
  expect(html).not.toContain("actor-full-id");
  expect(html).not.toContain("/admin/ai?sec=usage");
});
