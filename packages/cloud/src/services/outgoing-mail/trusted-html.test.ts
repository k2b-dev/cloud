import { expect, test } from "bun:test";
import { MailMessageSchema } from "../../contracts/outgoing-mail";
import { sanitizeEmailHtml } from "../../shared/email-html";

test("public acceptance sanitizes HTML; internal notification acceptance preserves every frame byte", async () => {
  const frame =
    '\n<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><img src="https://example.test/logo.svg"><p>Hello</p></body></html>\n';
  const script = `
    import { strict as assert } from "node:assert";
    import { insertMailMessage } from ${JSON.stringify(new URL("./messages.ts", import.meta.url).pathname)};
    const frame = ${JSON.stringify(frame)};
    const message = { to: ["reader@example.org"], subject: "Hello", text: "Hello", html: frame };
    let stored;
    const db = async (parts, ...values) => { stored = values[13]; return [{ id: "message" }]; };
    const profile = { id: "profile", key: "default", from_address: "sender@example.org" };
    for (const batchId of [undefined, "batch"]) {
      await insertMailMessage(db, "core", "id", message, { metadata: [], refs: [] }, profile, batchId);
      assert.equal(stored, ${JSON.stringify(sanitizeEmailHtml(frame))});
      assert.ok(!stored.includes("<!DOCTYPE")); assert.ok(!stored.includes("<img"));
      await insertMailMessage(db, "core", "id", message, { metadata: [], refs: [] }, profile, batchId, { trustedHtml: true });
      assert.equal(stored, frame);
    }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(
    MailMessageSchema.safeParse({ to: ["reader@example.org"], subject: "Hello", text: "Hello", html: frame, trustedHtml: true }).success,
  ).toBe(false);
});
