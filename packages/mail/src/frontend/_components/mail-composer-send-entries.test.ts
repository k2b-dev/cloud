import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Lesson 2026-11-20 (#3859): a Send that ends without a visible answer is a bug. `sendDraft` returns at once while Send
// waits (`sendHeld`). Only the Send buttons may call it directly: they are disabled in exactly that case, and the reply
// box names the reason beside them. Every other way in (Mod+Enter, Send later, Try again, the host's send) goes through
// `sendOrSayWhy`, which answers a held Send in the toast.
test("every way into sendDraft is a Send button that waits with sendHeld, or goes through sendOrSayWhy", () => {
  const source = readFileSync(new URL("./MailComposer.tsx", import.meta.url), "utf8");
  const calls = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bsendDraft\(/.test(line) && !line.startsWith("const sendDraft"));
  const buttons = calls.filter((line) => line.startsWith("onClick={() => void sendDraft("));
  const others = calls.filter((line) => !buttons.includes(line));
  expect(others).toEqual(["if (!sendHeld()) return sendDraft(delivery);"]);
  expect(buttons.length).toBeGreaterThan(0);
  // Each Send button that calls it directly is disabled while Send waits.
  for (const match of source.matchAll(/onClick=\{\(\) => void sendDraft\(/g)) {
    const element = source.slice(source.lastIndexOf("<", match.index), match.index);
    expect(element).toContain("disabled={sendHeld()}");
  }
});
