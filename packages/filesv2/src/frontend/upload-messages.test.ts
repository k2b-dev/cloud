import { expect, test } from "bun:test";
import { UploadTransferError } from "../upload-transfer";
import { uploadFailureReason, useUploadMessages } from "./upload-messages";

test("upload failures distinguish Cloud deadlines from stalled Filegate transfers", () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  try {
    const t = useUploadMessages()();
    const cause = new DOMException("Request timed out", "TimeoutError");
    expect(uploadFailureReason(cause, t)).toBe("No response from the server");
    expect(uploadFailureReason(new UploadTransferError("Upload failed", "stalled", cause), t)).toBe("No response from the file server");
  } finally {
    if (descriptor) Object.defineProperty(navigator, "onLine", descriptor);
    else Reflect.deleteProperty(navigator, "onLine");
  }
});
