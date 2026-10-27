import { expect, test } from "bun:test";
import { mailSummaryMessages } from "./mail-summary-messages";

test("de/en summary messages stay aligned", () => expect(mailSummaryMessages.check()).toEqual([]));
