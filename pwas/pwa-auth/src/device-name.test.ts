import { expect, test } from "bun:test";
import { type DeviceHints, suggestDeviceName } from "./device-name";

const text = { device: "Mein Gerät", browser: "Browser", on: (browser: string, os: string) => `${browser} auf ${os}` };
const hints = (userAgent: string, extra: Partial<DeviceHints> = {}): DeviceHints => ({
  userAgent,
  platform: "Linux x86_64",
  maxTouchPoints: 0,
  ...extra,
});
test("Android asks only for model and platformVersion; preserves reported model names and numbers", async () => {
  for (const model of ["Pixel 8", "SM-S911B"]) {
    expect(
      await suggestDeviceName(
        hints("Android 10; K", {
          userAgentData: {
            platform: "Android",
            getHighEntropyValues: async (requested) => {
              expect(requested).toEqual(["model", "platformVersion"]);
              return { model, platformVersion: "16.0.0" };
            },
          },
        }),
        text,
      ),
    ).toBe(model);
  }
});
test("missing or refused hints retain an honest Android fallback", async () => {
  expect(await suggestDeviceName(hints("Android 10; K"), text)).toBe("Android 10");
  expect(
    await suggestDeviceName(
      hints("Android", {
        userAgentData: {
          platform: "Android",
          getHighEntropyValues: async () => {
            throw new Error();
          },
        },
      }),
      text,
    ),
  ).toBe("Android");
  expect(
    await suggestDeviceName(
      hints("Android 10", {
        userAgentData: { platform: "Android", getHighEntropyValues: async () => ({ model: "", platformVersion: "16.0.0" }) },
      }),
      text,
    ),
  ).toBe("Android 16.0.0");
});
test("iOS uses only the reported device family/version, including desktop-mode iPad", async () => {
  expect(await suggestDeviceName(hints("iPhone; CPU iPhone OS 18_6 like Mac OS X"), text)).toBe("iPhone (iOS 18.6)");
  expect(await suggestDeviceName(hints("iPad; CPU OS 18_6 like Mac OS X"), text)).toBe("iPad (iPadOS 18.6)");
  expect(
    await suggestDeviceName(
      hints("Macintosh; Intel Mac OS X 10_15_7 Version/18.6 Safari/605.1.15", { platform: "MacIntel", maxTouchPoints: 5 }),
      text,
    ),
  ).toBe("iPad");
});
test("desktop names use browser and OS without identifying hardware", async () => {
  expect(await suggestDeviceName(hints("Macintosh; Intel Mac OS X 10.15; Firefox/143.0"), text)).toBe("Firefox auf macOS");
  expect(await suggestDeviceName(hints("Windows NT 10.0 Chrome/142.0 Edg/142.0"), text)).toBe("Edge auf Windows");
  expect(await suggestDeviceName(hints("X11; Linux x86_64 Chrome/142.0"), text)).toBe("Chrome auf Linux");
  expect(await suggestDeviceName(hints(""), text)).toBe("Mein Gerät");
});
