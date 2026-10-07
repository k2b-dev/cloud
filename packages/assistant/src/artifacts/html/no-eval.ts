// Imported first by the prelude: the app CSP allows no eval, and zod would otherwise probe
// `new Function` while other modules load, so every app would log a sandbox violation.
import { z } from "zod";

z.config({ jitless: true });
