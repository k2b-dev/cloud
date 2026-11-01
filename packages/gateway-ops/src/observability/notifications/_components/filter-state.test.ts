import { describe, expect, test } from "bun:test";
import {
  buildDeliveryNotificationsUrl,
  buildLegacyNotificationsUrl,
  buildRegistryNotificationsUrl,
  notificationChannelIcon,
  notificationChannelLabel,
  parseDeliveryStatus,
  parseFilterList,
  parseNotificationAdminView,
  parseRegistryStatus,
} from "./filter-state";

describe("notification admin filter state", () => {
  test("parses only supported views and statuses", () => {
    expect(parseNotificationAdminView("registry")).toBe("registry");
    expect(parseNotificationAdminView("unknown")).toBe("deliveries");
    expect(parseDeliveryStatus("failed")).toBe("failed");
    expect(parseDeliveryStatus("sent")).toBe("all");
    expect(parseRegistryStatus("inactive")).toBe("inactive");
    expect(parseRegistryStatus("failed")).toBe("all");
  });

  test("deduplicates list filters and keeps pagination URLs view-specific", () => {
    expect(parseFilterList("browser,email,browser,, email ")).toEqual(["browser", "email"]);
    expect(notificationChannelLabel("none")).toBe("No channel");
    expect(notificationChannelIcon("browser")).toBe("ti ti-bell");
    expect(
      buildDeliveryNotificationsUrl({
        search: "provider error",
        status: "failed",
        channels: ["browser"],
        appIds: ["assistant"],
        page: 2,
      }),
    ).toBe("/admin/observability/deliveries?search=provider+error&status=failed&channels=browser&apps=assistant&page=2");
    expect(buildRegistryNotificationsUrl({ search: "", status: "active", appIds: [] })).toBe(
      "/admin/observability/deliveries?view=registry&status=active",
    );
    expect(buildLegacyNotificationsUrl({ search: "", status: "all" })).toBe("/admin/observability/deliveries?view=legacy");
  });
});
