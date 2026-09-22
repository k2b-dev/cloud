/** Disposable child of the ZIP crash test; never an application worker entry point. */
import { spyOn } from "bun:test";
import { sql } from "bun";
import { localVerificationUrl } from "../../scripts/verification";
import { createDocumentIssuanceService } from "./document-issuance";
import * as zipOutput from "./document-zip-output";

const [requestJson] = process.argv.slice(2);
const database = localVerificationUrl("PostgreSQL", process.env.DATABASE_URL);
if (!database.pathname.endsWith("_test") || !requestJson) throw new Error("Crash worker requires a _test database and a request");

// Pause once the first staged chunk is durable inside the open transaction; the
// parent kills this process there so the transaction aborts mid-archive.
const write = zipOutput.writeDocumentZip;
let paused = false;
spyOn(zipOutput, "writeDocumentZip").mockImplementation((input, client, sink) =>
  write(input, client, async (bytes) => {
    await sink(bytes);
    if (paused) return;
    paused = true;
    process.send?.({ checkpoint: "first-chunk" });
    await new Promise<void>((resolve) => process.once("message", () => resolve()));
  }),
);

try {
  process.send?.({ ready: true });
  await new Promise<void>((resolve) => process.once("message", () => resolve()));
  const result = await createDocumentIssuanceService().issueQueryDocument({ ...JSON.parse(requestJson), authorize: async () => {} });
  console.info(JSON.stringify(result));
} finally {
  await sql.close({ timeout: 5 });
}
