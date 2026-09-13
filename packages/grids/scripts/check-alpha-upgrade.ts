import { SQL } from "bun";
import { assertGridsAlphaContract } from "../src/workflows/migrate";

// Run against a restored copy before replacing an older Grids image.
// The same guard is used by startup; it locks inspected tables but writes nothing.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const database = new SQL(process.env.DATABASE_URL);
try {
  await database.begin((transaction) => assertGridsAlphaContract(transaction));
  console.info("Grids alpha contract accepted. No data or schema was changed. This is not a full migration or runtime check.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Grids alpha upgrade check failed");
  process.exitCode = 1;
} finally {
  await database.close();
}
