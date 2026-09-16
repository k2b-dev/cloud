/** Disposable child of the crash acceptance test; never an application worker entry point. */
import { spyOn } from "bun:test";
import { request } from "node:http";
import { bindProcessSync } from "@k2b/cloud";
import { createSync } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { sql } from "bun";
import { localVerificationUrl } from "../../scripts/verification";
import { DocumentTemplateRendererSchema } from "../contracts";
import { gridsWorkflows } from "../workflows/module";
import * as rendering from "./document-rendering";
import * as http from "./workflow-http-client";
import { runGridsWorkflowRun } from "./workflow-runtime";

const [runId, checkpoint, namespace, receiverPort] = process.argv.slice(2);
const database = localVerificationUrl("PostgreSQL", process.env.DATABASE_URL);
if (!/^\/grids_verify_[a-f0-9]{32}$/.test(database.pathname) || !runId || !namespace?.startsWith("grids-crash-")) {
  throw new Error("Crash worker requires an isolated verification database and namespace");
}
const connection = await connect({
  servers: localVerificationUrl("NATS", process.env.SYNC_TEST_SERVERS).toString(),
  ignoreClusterUpdates: true,
});
const sync = createSync({ connection, namespace, application: "grids", defaults: { replicas: 1 } });
bindProcessSync(sync);

const pause = async (point: string) => {
  if (checkpoint !== point) return;
  console.info(`Paused at ${point}`);
  process.send?.({ checkpoint: point });
  await new Promise<void>((resolve) => process.once("message", () => resolve()));
};

// Use the real renderer with the dedicated test endpoint. Only the pause is injected.
spyOn(rendering, "renderDocumentPdf").mockImplementation(async (document, locale) => {
  await pause("receipt-reserved");
  const content = DocumentTemplateRendererSchema.parse(document.templateSnapshot.renderer);
  if (content.kind !== "html") throw new Error("Crash fixture requires an HTML document");
  return rendering.renderDocumentHtmlPdf({ content, data: document.renderData, filename: document.filename }, locale, {
    config: {
      url: localVerificationUrl("Gotenberg", process.env.GRIDS_PDF_URL).toString(),
      timeoutMs: 30_000,
      maxHtmlBytes: 1_000_000,
      maxPdfBytes: 10_000_000,
    },
  });
});
const generate = gridsWorkflows.actions.generateDocument.run;
spyOn(gridsWorkflows.actions.generateDocument, "run").mockImplementation(async (ctx, config) => {
  const result = await generate(ctx, config);
  if (result.state === "succeeded") await pause("document-committed");
  return result;
});

// Route only this test's HTTP transport to its local receiver. The production
// request lifecycle, response parsing, effect key and reconciliation still run.
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const preflight = http.preflightWorkflowHttp;
const send = http.requestWorkflowHttp;
spyOn(http, "preflightWorkflowHttp").mockImplementation((input) => preflight(input, { lookup }));
spyOn(http, "requestWorkflowHttp").mockImplementation((input) =>
  send(input, {
    lookup,
    request: (options, callback) => request({ ...options, hostname: "127.0.0.1", port: Number(receiverPort), lookup: undefined }, callback),
  }),
);

try {
  process.send?.({ ready: true });
  await new Promise<void>((resolve) => process.once("message", () => resolve()));
  console.info(JSON.stringify(await runGridsWorkflowRun(runId)));
} finally {
  await sync.drain({ timeoutMs: 5_000 });
  await connection.drain();
  await sql.close({ timeout: 5 });
}
