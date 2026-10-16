import { afterEach, beforeEach, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent, createRoot } from "solid-js";
import { UploadTransferError } from "../upload-transfer";
import { uploadFailureReason, useUploadMessages } from "./upload-messages";

const descriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
beforeEach(() => Object.defineProperty(navigator, "onLine", { configurable: true, value: true }));
afterEach(() => {
  if (descriptor) Object.defineProperty(navigator, "onLine", descriptor);
  else Reflect.deleteProperty(navigator, "onLine");
});
function reason(error: unknown, locale = "en") {
  return createRoot((dispose) => {
    let text = "";
    createComponent(LocaleProvider, {
      locale,
      get children() {
        text = uploadFailureReason(error, useUploadMessages()());
        return null;
      },
    });
    dispose();
    return text;
  });
}

test.each([
  {
    locale: "en",
    filegate: "No response from the file server",
    cloud: "No response from the server",
    limited: "Too many uploads in a short time",
  },
  {
    locale: "de",
    filegate: "Keine Antwort vom Dateiserver",
    cloud: "Keine Antwort vom Server",
    limited: "Zu viele Uploads in kurzer Zeit",
  },
])("upload reasons distinguish origins and rate limits ($locale)", ({ locale, filegate, cloud, limited }) => {
  const cause = new DOMException("Request timed out", "TimeoutError");
  expect(reason(cause, locale)).toBe(cloud);
  expect(reason(new UploadTransferError("Upload failed", "stalled", cause), locale)).toBe(filegate);
  expect(reason(new UploadTransferError("Upload failed", "stalled", cause, undefined, "cloud"), locale)).toBe(cloud);
  expect(reason(new UploadTransferError("429 Rate limit exceeded", "rate_limited", cause, 1000, "cloud"), locale)).toBe(limited);
});

test("network failures use the connection reason and server/final failures retain their message", () => {
  expect(reason(new UploadTransferError("failed", "network", null))).toBe("No connection");
  for (const kind of ["server", "final"] as const) {
    expect(reason(new UploadTransferError("The file changed", kind, null, undefined, "cloud"))).toBe("The file changed");
    expect(reason(new UploadTransferError("", kind, null))).toBe("Could not be uploaded");
  }
});
