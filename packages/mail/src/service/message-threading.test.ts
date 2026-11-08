import { describe, expect, test } from "bun:test";
import { hasReplySubjectPrefix, normalizeMailSubject } from "./message-threading";

describe("mail subject threading", () => {
  test("keeps tags containing digits or hashes in the normalized subject", () => {
    for (const tag of ["Ticket#1001", "Ticket2002", "Case#", "dev2"]) {
      expect(normalizeMailSubject(`[${tag}] Re: Invoice`)).toBe(`[${tag.toLowerCase()}] invoice`);
      expect(normalizeMailSubject(`Re: [${tag}] Invoice`)).toBe(`[${tag.toLowerCase()}] invoice`);
    }
    expect(normalizeMailSubject("[EXTERNAL] Re: [dev] Invoice")).toBe("invoice");
  });
  test("recognizes reply and forward prefixes that normalization removes", () => {
    for (const subject of [
      "Re: Invoice",
      "AW: Invoice",
      "  re[2]:  Invoice",
      "Fwd: Invoice",
      "WG: Re: Invoice",
      "RV: Invoice",
      "SV: Invoice",
      "Antw: Invoice",
      "RE : Invoice",
      "[EXTERNAL] Re: Invoice",
      "Re: [EXT] Invoice",
      "[list] Re: Invoice",
    ]) {
      expect(hasReplySubjectPrefix(subject)).toBe(true);
      expect(normalizeMailSubject(subject)).toBe("invoice");
    }
    for (const subject of ["Invoice", "Regarding: Invoice", "Invoice Re: March", ""]) {
      expect(hasReplySubjectPrefix(subject)).toBe(false);
    }
  });
});
