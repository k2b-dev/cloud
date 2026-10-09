import { mkdtempSync } from "node:fs";
import { join } from "node:path";

/** Parent of temporary projects: their files still resolve this package's dependencies. */
export const tempRootParent = join(import.meta.dir, "..", "node_modules");

/**
 * Creates a temporary project root for building islands. It lives in the
 * package's `node_modules`, which Git and the repository checks skip, so a
 * concurrent check never reads generated files a test is about to delete.
 */
export const makeTempRoot = (prefix: string): string => mkdtempSync(join(tempRootParent, prefix));
