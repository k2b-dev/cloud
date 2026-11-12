/** Child-process witness: a regression must not wedge the test runner's SQL pool. */
import { sql } from "@k2b/cloud";
import { closePlatformClients } from "../../../cloud/src/runtime/clients";
import { awaitDraftDocumentQuery, withDraftDocumentTransaction } from "../../src/service/draft-document-socket-sql";

const controllers = [new AbortController(), new AbortController()];
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let active = 0;
try {
  const results = Promise.allSettled(
    controllers.map((controller) =>
      withDraftDocumentTransaction(controller.signal, async () => {
        if (++active === controllers.length) entered.resolve();
        await release.promise;
      }),
    ),
  );
  await entered.promise; // Both slots of CLOUD_DATABASE_POOL_MAX=2 are reserved.
  for (const controller of controllers) controller.abort();
  release.resolve();
  const settled = await results;
  if (settled.some((result) => result.status !== "rejected")) throw new Error("An aborted transaction succeeded");
  const alreadyStopped = new AbortController();
  try {
    await withDraftDocumentTransaction(alreadyStopped.signal, async (db) => {
      alreadyStopped.abort();
      await awaitDraftDocumentQuery(db`SELECT 1`, alreadyStopped.signal);
    });
    throw new Error("Already-aborted lazy query succeeded");
  } catch (error) {
    if (error !== alreadyStopped.signal.reason) throw error;
  }
  await sql`SELECT 1`;
  console.log("cancelled=2 sql-pool-recovered lazy-query-not-started");
} finally {
  await closePlatformClients();
}
