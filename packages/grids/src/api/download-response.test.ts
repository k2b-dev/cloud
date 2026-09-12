import { expect, test } from "bun:test";
import { fileResponse } from "./download-response";

test("artifact downloads preserve their media type and prevent content sniffing", async () => {
  const bytes = new TextEncoder().encode("amount\n12.30\n");
  const response = fileResponse(bytes, "Auslagen.csv", "text/csv");
  expect(response.headers.get("Content-Type")).toBe("text/csv");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Content-Disposition")).toContain('filename="Auslagen.csv"');
  expect(await response.text()).toBe("amount\n12.30\n");
});

test("an absent filename does not mislabel a non-PDF artifact", () => {
  const response = fileResponse(new Uint8Array(), "", "application/json");
  expect(response.headers.get("Content-Disposition")).toContain('filename="document"');
});
