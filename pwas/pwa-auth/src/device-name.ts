/** Browser-reported hints only. No hardware probing or model-number lookup. */
export type DeviceHints = Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> & {
  userAgentData?: {
    platform: string;
    getHighEntropyValues: (hints: string[]) => Promise<{ model?: string; platformVersion?: string }>;
  };
};

export async function suggestDeviceName(
  hints: DeviceHints,
  text: { device: string; browser: string; on: (browser: string, os: string) => string },
): Promise<string> {
  const ua = hints.userAgent;
  const ipad = /iPad/i.test(ua) || (hints.platform === "MacIntel" && hints.maxTouchPoints > 1);
  if (ipad || /iPhone|iPod/i.test(ua)) {
    const device = ipad ? "iPad" : /iPod/i.test(ua) ? "iPod" : "iPhone";
    // Desktop-mode iPad reports a macOS version, not an iPadOS version. Never use that as iOS.
    const version = /(?:CPU (?:iPhone )?OS|iPhone OS) ([\d_]+)/.exec(ua)?.[1]?.replaceAll("_", ".");
    return version ? `${device} (${ipad ? "iPadOS" : "iOS"} ${version})` : device;
  }
  if (/Android/i.test(ua) || hints.userAgentData?.platform === "Android") {
    let version = /Android ([\d.]+)/.exec(ua)?.[1];
    try {
      const values = await hints.userAgentData?.getHighEntropyValues(["model", "platformVersion"]);
      const model = values?.model?.trim();
      if (model) return model.slice(0, 80);
      version = values?.platformVersion || version;
    } catch {
      // Permission policy, browser privacy settings or unsupported hints leave a useful generic suggestion.
    }
    return version ? `Android ${version}` : "Android";
  }
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : text.browser;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /CrOS/.test(ua)
      ? "ChromeOS"
      : /Macintosh|Mac OS X/.test(ua)
        ? "macOS"
        : /Linux/.test(ua)
          ? "Linux"
          : undefined;
  return os ? text.on(browser, os) : browser === text.browser ? text.device : browser;
}
