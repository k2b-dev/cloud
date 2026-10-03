import { describe, expect, test } from "bun:test";
import { hasReplySubjectPrefix, normalizeMailSubject } from "./message-threading";

describe("mail subject threading", () => {
  test("recognizes reply and forward prefixes that normalization removes", () => {
    for (const subject of ["Re: Invoice", "AW: Invoice", "  re[2]:  Invoice", "Fwd: Invoice", "WG: Re: Invoice"]) {
      expect(hasReplySubjectPrefix(subject)).toBe(true);
      expect(normalizeMailSubject(subject)).toBe("invoice");
    }
    for (const subject of ["Invoice", "Regarding: Invoice", "Invoice Re: March", ""]) {
      expect(hasReplySubjectPrefix(subject)).toBe(false);
    }
  });
});
