/**
 * `AppContext<App>` — Hono context type for routes mounted by an app.
 *
 * Combines the existing `AuthContext` variables (user, sessionToken) with a
 * typed per-request settings snapshot derived from the app's `defineApp.settings`
 * declaration.
 *
 * Convention: each app exports a named alias from its `index.ts`:
 *
 *   ```ts
 *   import { app } from "./config";
 *   import type { AppContext } from "@k2b/cloud/server";
 *   export type FilesAppContext = AppContext<typeof app>;
 *   ```
 *
 * Then routes:
 *
 *   ```ts
 *   import { type FilesAppContext } from "..";
 *   new Hono<FilesAppContext>().get("/", (c) => {
 *     const s = c.get("settings");          // typed nested readonly object
 *     s.app.name                             // string (from core's settings)
 *     s.files.filegate_url                   // string (from app-files's own settings)
 *   });
 *   ```
 *
 * The `settings` variable is populated by the per-request snapshot middleware
 * registered by `app.start()`; the snapshot is frozen for the duration of the
 * request.
 */
import type { AppDefinition } from "../_internal/define-app";
import type { AppSettings } from "../contracts/settings-types";
import type { AuthContext } from "./middleware/auth";

export type AppContext<App extends AppDefinition<any>> = {
  Variables: AuthContext["Variables"] & {
    settings: AppSettings<App>;
  };
};
