import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  isSupported,
  getPermission,
  requestPermission,
  show,
  notifications,
} from "./notifications";

// ─── Mock helpers ───────────────────────────────────────────────────────────────

let mockPermission: string;
let mockInstances: Array<{
  title: string;
  options: any;
  onclick: ((this: Notification) => void) | null;
  onclose: (() => void) | null;
  close: ReturnType<typeof mock>;
}>;

const installNotificationMock = (permission: string = "granted") => {
  mockPermission = permission;
  mockInstances = [];

  const MockNotification = function (this: any, title: string, options: any) {
    this.title = title;
    this.options = options;
    this.onclick = null;
    this.onclose = null;
    this.close = mock(() => {
      if (this.onclose) this.onclose();
    });
    mockInstances.push(this);
  } as any;

  Object.defineProperty(MockNotification, "permission", {
    get: () => mockPermission,
    configurable: true,
  });

  MockNotification.requestPermission = mock(async () => {
    mockPermission = "granted";
    return "granted";
  });

  (globalThis as any).Notification = MockNotification;
  (globalThis as any).window = globalThis;
  (globalThis as any).window.focus = mock(() => {});
};

const removeNotificationMock = () => {
  delete (globalThis as any).Notification;
  mockInstances = [];
};

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("notifications", () => {
  afterEach(() => {
    removeNotificationMock();
  });

  // ── isSupported ─────────────────────────────────────────────────────────────

  describe("isSupported", () => {
    it("returns false when Notification API is unavailable", () => {
      removeNotificationMock();
      expect(isSupported()).toBe(false);
    });

    it("returns true when Notification API is available", () => {
      installNotificationMock("granted");
      expect(isSupported()).toBe(true);
    });
  });

  // ── getPermission ─────────────────────────────────────────────────────────────

  describe("getPermission", () => {
    it("returns current permission state", () => {
      installNotificationMock("default");
      expect(getPermission()).toBe("default");
    });

    it("reflects granted permission", () => {
      installNotificationMock("granted");
      expect(getPermission()).toBe("granted");
    });

    it("reflects denied permission", () => {
      installNotificationMock("denied");
      expect(getPermission()).toBe("denied");
    });
  });

  // ── requestPermission ─────────────────────────────────────────────────────────

  describe("requestPermission", () => {
    it("returns true when permission is granted", async () => {
      installNotificationMock("default");
      const result = await requestPermission();
      expect(result).toBe(true);
    });

    it("calls Notification.requestPermission", async () => {
      installNotificationMock("default");
      await requestPermission();
      expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
    });

    it("returns false when permission is denied", async () => {
      installNotificationMock("default");
      (Notification.requestPermission as any) = mock(async () => {
        mockPermission = "denied";
        return "denied";
      });
      const result = await requestPermission();
      expect(result).toBe(false);
    });
  });

  // ── show ──────────────────────────────────────────────────────────────────────

  describe("show", () => {
    beforeEach(() => {
      installNotificationMock("granted");
    });

    it("returns a handle with close() when permission is granted", () => {
      const handle = show({ title: "Test", body: "Hello" });
      expect(handle).not.toBeNull();
      expect(typeof handle!.close).toBe("function");
    });

    it("returns null when permission is not granted", () => {
      installNotificationMock("denied");
      const handle = show({ title: "Test", body: "Hello" });
      expect(handle).toBeNull();
    });

    it("returns null when permission is default (not yet requested)", () => {
      installNotificationMock("default");
      const handle = show({ title: "Test", body: "Hello" });
      expect(handle).toBeNull();
    });

    it("creates a Notification with correct title and body", () => {
      show({ title: "My Title", body: "My Body" });
      expect(mockInstances).toHaveLength(1);
      expect(mockInstances[0]!.title).toBe("My Title");
      expect(mockInstances[0]!.options.body).toBe("My Body");
    });

    it("passes icon, image, and tag to Notification", () => {
      show({
        title: "T",
        body: "B",
        icon: "/icon.png",
        image: "/image.jpg",
        tag: "my-tag",
      });
      const opts = mockInstances[0]!.options;
      expect(opts.icon).toBe("/icon.png");
      expect(opts.image).toBe("/image.jpg");
      expect(opts.tag).toBe("my-tag");
    });

    it("close() calls notification.close()", () => {
      const handle = show({ title: "T", body: "B" })!;
      handle.close();
      expect(mockInstances[0]!.close).toHaveBeenCalledTimes(1);
    });

    it("close() is safe to call multiple times", () => {
      const handle = show({ title: "T", body: "B" })!;
      handle.close();
      handle.close();
      handle.close();
      expect(mockInstances[0]!.close).toHaveBeenCalledTimes(3);
    });

    // ── onClick ───────────────────────────────────────────────────────────────

    it("onClick callback is invoked when notification is clicked", () => {
      const onClick = mock(() => {});
      show({ title: "T", body: "B", onClick });

      const n = mockInstances[0]!;
      expect(n.onclick).not.toBeNull();

      // Simulate click
      n.onclick!.call(n as any);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("clicking notification closes it automatically", () => {
      show({ title: "T", body: "B", onClick: () => {} });
      const n = mockInstances[0]!;
      n.onclick!.call(n as any);
      expect(n.close).toHaveBeenCalled();
    });

    it("no onclick handler when onClick is omitted", () => {
      show({ title: "T", body: "B" });
      expect(mockInstances[0]!.onclick).toBeNull();
    });

    // ── onClose ───────────────────────────────────────────────────────────────

    it("onClose callback is set on notification", () => {
      const onClose = mock(() => {});
      show({ title: "T", body: "B", onClose });
      expect(mockInstances[0]!.onclose).toBe(onClose);
    });

    it("onClose is called when notification.close() fires", () => {
      const onClose = mock(() => {});
      show({ title: "T", body: "B", onClose });
      mockInstances[0]!.close();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    // ── autoCloseMs ───────────────────────────────────────────────────────────

    it("auto-closes after autoCloseMs", async () => {
      show({ title: "T", body: "B", autoCloseMs: 50 });
      const n = mockInstances[0]!;
      expect(n.close).not.toHaveBeenCalled();

      await new Promise((r) => setTimeout(r, 80));
      expect(n.close).toHaveBeenCalled();
    });

    it("manual close() cancels the auto-close timer", async () => {
      const handle = show({ title: "T", body: "B", autoCloseMs: 50 })!;
      handle.close(); // close immediately, should cancel timer

      const closeCount = mockInstances[0]!.close.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80));
      // Should not have been called again by the timer
      expect(mockInstances[0]!.close.mock.calls.length).toBe(closeCount);
    });

    it("does not auto-close when autoCloseMs is omitted", async () => {
      show({ title: "T", body: "B" });
      await new Promise((r) => setTimeout(r, 50));
      expect(mockInstances[0]!.close).not.toHaveBeenCalled();
    });

    it("does not auto-close when autoCloseMs is 0", async () => {
      show({ title: "T", body: "B", autoCloseMs: 0 });
      await new Promise((r) => setTimeout(r, 50));
      expect(mockInstances[0]!.close).not.toHaveBeenCalled();
    });
  });

  // ── Namespace ─────────────────────────────────────────────────────────────────

  describe("namespace", () => {
    it("exports all functions under notifications namespace", () => {
      expect(notifications.isSupported).toBe(isSupported);
      expect(notifications.getPermission).toBe(getPermission);
      expect(notifications.requestPermission).toBe(requestPermission);
      expect(notifications.show).toBe(show);
    });
  });
});
