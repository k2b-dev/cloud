import { afterEach, expect, spyOn, test } from "bun:test";
import { filesService } from "../service";
import { inlinePdfApi } from "./inline-pdf";

afterEach(() => {
  spyOn(filesService, "inlinePdf").mockRestore();
});

const pdfStream = () => new Response("%PDF-1.7\n").body!;

test("the API route reads the exact stored path of an encoded address", async () => {
  const requests: unknown[] = [];
  spyOn(filesService, "inlinePdf").mockImplementation(async (_actor, input) => {
    requests.push(input);
    return { name: "Q3 Bericht über #1 (100%).pdf", length: "9", body: pdfStream() };
  });
  const path = "Team Ordner/2026?/Q3 Bericht über #1 (100%).pdf";
  const response = await inlinePdfApi.request(
    `/bases/${encodeURIComponent("freeipa:users:5f0c")}/pdf/${path.split("/").map(encodeURIComponent).join("/")}`,
  );
  expect(response.status).toBe(200);
  expect(requests).toEqual([{ baseId: "freeipa:users:5f0c", path }]);
  expect(await response.text()).toBe("%PDF-1.7\n");
});

test("a PDF is served inline with its name, locked down and never cached", async () => {
  spyOn(filesService, "inlinePdf").mockResolvedValue({ name: 'Q3 "Bericht" über (1).pdf', length: "9", body: pdfStream() });
  const response = await inlinePdfApi.request("/bases/base/pdf/Q3.pdf");
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  expect(headers).toEqual({
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="Q3 _Bericht_ _ber (1).pdf"; filename*=UTF-8''Q3%20%22Bericht%22%20%C3%BCber%20%281%29.pdf`,
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "cross-origin-resource-policy": "same-origin",
    "content-length": "9",
  });
});

test("a path beyond the stored-path limit is refused before any storage read", async () => {
  const read = spyOn(filesService, "inlinePdf");
  const response = await inlinePdfApi.request(`/bases/base/pdf/${"a/".repeat(2048)}b.pdf`);
  expect(response.status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});
