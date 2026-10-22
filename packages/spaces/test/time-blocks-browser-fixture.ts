import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserName } from "../../ui/test/browser";

// Optional artifact destination belongs to the test harness, never application configuration.
export const timeBlockScreenshotDirectory = process.env.SPACES_TIME_BLOCK_SCREENSHOTS ?? join(tmpdir(), "spaces-time-blocks", browserName);
