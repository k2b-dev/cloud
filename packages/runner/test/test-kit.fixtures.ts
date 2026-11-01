import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { generateCodeSdk } from "@k2b/cloud/code";
import { z } from "zod";
export const now = Date.UTC(2030, 0, 2, 8);
export const target = { type: "spaces.space", id: "sp_fixture" };
// A declarative provider fixture, never the installed Spaces application or its services.
export const sdk = generateCodeSdk(
  [
    compileCapabilityManifest("spaces", {
      protocolVersion: 2,
      types: { space: { title: "Space", description: "A fixture Space." } },
      actions: {
        "task.create": {
          title: "Create task",
          description: "A fixture action.",
          target: "space",
          idempotency: "required",
          openWorld: false,
          destructive: false,
          input: z.object({ title: z.string().describe("Fixture title.") }).strict(),
          data: z.object({ id: z.string() }).strict(),
          run: () => {
            throw new Error("real_provider_must_never_run");
          },
        },
      },
    }),
  ],
  { mode: "resource", owner: { kind: "resource", ref: target } },
);

export const ACCEPTANCE_SOURCE = `import { app, owner } from "@sdk";
app.schedule("0 8 * * *", async () => { await owner.task.create({ title: String(Date.now()), idempotencyKey: "invoice:one" }); }, { name: "weekly" }); export default app;`;
