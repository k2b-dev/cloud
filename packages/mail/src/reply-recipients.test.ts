import { describe, expect, test } from "bun:test";
import { deriveReplyAddressObjects } from "./reply-recipients";

const identities = [{ fromAddress: "info@example.test", replyTo: "alias@example.test" }];
const own = { name: null, address: "INFO@example.test" };
const alias = { name: null, address: "alias@example.test" };

for (const intent of ["reply", "reply_all"] as const) {
  describe(intent, () => {
    test("leaves recipients empty when every participant is a mailbox identity", () => {
      expect(deriveReplyAddressObjects({ from: [own], replyTo: [alias], to: [own, alias], cc: [alias] }, intent, identities)).toEqual({
        to: [],
        cc: [],
      });
    });
    test("keeps external recipients of a message sent by the mailbox", () => {
      const external = { name: null, address: "recipient@example.test" };
      expect(deriveReplyAddressObjects({ from: [own], replyTo: [], to: [own, external], cc: [] }, intent, identities)).toEqual({
        to: [external],
        cc: [],
      });
    });
  });
}
