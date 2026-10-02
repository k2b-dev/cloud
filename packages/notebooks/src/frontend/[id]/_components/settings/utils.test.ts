import { expect, test } from "bun:test";
import { readErrorMessage } from "./utils";

test("an error message comes from the JSON body, and anything else keeps the localized fallback", async () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 403, headers: { "content-type": "application/json" } });
  expect(await readErrorMessage(json({ code: "NOTE_DELETE_ADMIN_ONLY", message: "Reserved for admins." }), "Failed")).toBe(
    "Reserved for admins.",
  );
  expect(await readErrorMessage(json({ message: "" }), "Failed")).toBe("Failed");
  // A proxy in front of the app can answer with an HTML error page.
  expect(await readErrorMessage(new Response("<html>Bad gateway</html>", { status: 502 }), "Failed")).toBe("Failed");
});
