import { afterAll } from "bun:test";

if (process.env.MAIL_INTEGRATION_TESTS === "1") {
  process.env.SYNC_NAMESPACE = `mail-test-${crypto.randomUUID()}`;
  process.env.NATS_IGNORE_CLUSTER_UPDATES = "true";
  const { startProcessSync } = await import("@valentinkolb/cloud");
  const runtime = await startProcessSync({ application: "mail" });
  afterAll(async () => {
    await runtime.stop();
  });
}
