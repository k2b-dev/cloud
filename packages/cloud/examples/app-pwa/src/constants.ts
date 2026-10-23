export const APP_ID = "visit-demo";
export const COUNTER_PATH = "/app/visit-demo/counter/";
export const STAFF_PATH = "/app/visit-demo/devices";
export const STAFF_API_PATH = "/api/visit-demo/app-pwa";
export const SUBJECT_ID = "10000000-0000-4000-8000-000000000001";
// Example policy: accept up to 256 KiB of signature JSON (ink or typed name).
export const MAX_SIGNATURE_BYTES = 256 * 1024;
// JSON can escape every UTF-16 code unit as six ASCII bytes. The remainder
// covers the fixed command envelope, UUIDs, revision and consent fields.
export const REQUEST_BYTES = MAX_SIGNATURE_BYTES * 6 + 1024;
// A page contains at most 20 devices, names <= 80 chars; the document view is
// fixed fictional text. One signature-sized response budget covers both.
export const RESPONSE_BYTES = MAX_SIGNATURE_BYTES;
export const DEVICE_PAGE_SIZE = 20;
