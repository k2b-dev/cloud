async function _run(page) {
  const results = [];
  for (const mode of ["decode", "invalid", "denied", "late", "hidden", "stop", "pagehide"]) {
    const context = await page
      .context()
      .browser()
      .newContext({ locale: "en", viewport: { width: 390, height: 844 }, reducedMotion: mode === "stop" ? "reduce" : "no-preference" });
    const p = await context.newPage();
    let apiCalls = 0;
    const browserErrors = [];
    p.on("console", (e) => {
      if (e.type() === "error") browserErrors.push(e.text());
    });
    p.on("pageerror", (e) => browserErrors.push(String(e)));
    p.on("requestfailed", (r) => browserErrors.push(r.url() + ": " + r.failure()?.errorText));
    p.on("request", (r) => {
      if (r.url().includes("/api/auth/app-approval/")) apiCalls++;
    });
    await context.route("**/test-qr.svg", (r) =>
      r.fulfill({
        path: mode === "invalid" ? "pwas/pwa-auth/test/fixtures/invalid.svg" : "pwas/pwa-auth/test/fixtures/pairing.svg",
        contentType: "image/svg+xml",
      }),
    );
    await context.route("**/test-valid-qr.svg", (r) =>
      r.fulfill({ path: "pwas/pwa-auth/test/fixtures/pairing.svg", contentType: "image/svg+xml" }),
    );
    await context.addInitScript(
      ({ mode }) => {
        delete window.BarcodeDetector; // Exercise the bundled Worker decoder, including its dynamic import.
        window.cameraTest = { calls: 0, tracks: [], release: undefined };
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async () => {
              window.cameraTest.calls++;
              if (mode === "denied") throw new DOMException("Denied", "NotAllowedError");
              if (mode === "late")
                await new Promise((resolve) => {
                  window.cameraTest.release = resolve;
                });
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 960;
              const ctx = canvas.getContext("2d");
              const img = new Image();
              window.cameraTest.image = img;
              if (mode === "decode" || mode === "invalid") {
                img.src = location.origin + "/test-qr.svg";
                await new Promise((resolve, reject) => {
                  img.onload = resolve;
                  img.onerror = reject;
                });
              }
              const paint = () => {
                ctx.fillStyle = "white";
                ctx.fillRect(0, 0, 960, 960);
                if (!window.cameraTest.blank && (mode === "decode" || mode === "invalid")) ctx.drawImage(img, 160, 160, 640, 640);
              };
              paint();
              const timer = setInterval(paint, 100);
              const stream = canvas.captureStream(10);
              const track = stream.getVideoTracks()[0];
              const stop = track.stop.bind(track);
              track.stop = () => {
                clearInterval(timer);
                stop();
              };
              window.cameraTest.tracks.push(track);
              return stream;
            },
          },
        });
      },
      { mode },
    );
    try {
      await p.goto("http://127.0.0.1:4178/");
      await p.getByRole("button", { name: "Continue in browser", exact: true }).click();
      await p.getByRole("button", { name: "Add Cloud", exact: true }).click();
      await p.getByRole("button", { name: "Set a six-digit app PIN", exact: true }).click();
      await p.getByLabel("App PIN", { exact: true }).fill("012345");
      await p.getByLabel("Repeat app PIN", { exact: true }).fill("012345");
      await p.getByRole("button", { name: "Save protection", exact: true }).click();
      await p.getByRole("heading", { name: "Add Cloud", exact: true }).waitFor();
      if ((await p.evaluate(() => window.cameraTest.calls)) !== 0) throw new Error("Camera opened before click");
      await p.getByRole("button", { name: "Scan QR code", exact: true }).click();
      if (mode === "decode") {
        await p.getByRole("button", { name: "Trust Cloud and pair", exact: true }).waitFor({ timeout: 20000 });
        if (!(await p.getByRole("dialog").textContent()).includes("https://qr-cloud.example.test")) throw new Error("Decoded wrong issuer");
        if (apiCalls) throw new Error("Scan trusted the issuer automatically");
      } else if (mode === "denied" || mode === "invalid") {
        await p.getByRole("dialog").getByRole("alert").waitFor();
        if (mode === "invalid") {
          await p.getByText("QR code cannot be used", { exact: true }).waitFor();
          await p.locator(".auth-camera-preview--invalid").waitFor();
          if (!(await p.evaluate(() => window.cameraTest.tracks.every((t) => t.readyState === "live"))))
            throw new Error("Invalid QR stopped camera");
          const toast = p.locator(".k2b-toast");
          await p.waitForTimeout(1200);
          if ((await toast.count()) !== 1) throw new Error("Continuous invalid QR repeated toast");
          await p.evaluate(() => {
            window.cameraTest.blank = true;
          });
          await p.waitForTimeout(1300);
          await p.evaluate(() => {
            window.cameraTest.blank = false;
          });
          await p.waitForFunction(() => document.querySelectorAll(".k2b-toast").length === 2);
          await p.screenshot({ path: "output/playwright/pwa-qr-invalid.png" });
          await p.evaluate(() => {
            window.cameraTest.image.src = location.origin + "/test-valid-qr.svg";
          });
          await p.getByRole("button", { name: "Trust Cloud and pair", exact: true }).waitFor();
          if ((await p.evaluate(() => window.cameraTest.calls)) !== 1) throw new Error("Scanner restarted camera");
        } else await p.getByRole("dialog").locator("input").fill("Still supports pasting");
      } else if (mode === "late") {
        await p.waitForFunction(() => typeof window.cameraTest.release === "function");
        await p.getByRole("button", { name: "Close", exact: true }).click();
        await p.evaluate(() => window.cameraTest.release());
        await p.waitForFunction(() => window.cameraTest.tracks.length > 0);
      } else if (mode === "stop" || mode === "pagehide") {
        await p.waitForFunction(() => window.cameraTest.tracks.length > 0);
        const preview = p.getByRole("dialog").locator(".auth-camera-preview video");
        await preview.waitFor({ state: "visible" });
        const size = await preview.boundingBox();
        if (!size || size.width < 100 || size.height < 100) throw new Error("Camera preview is hidden");
        if (mode === "stop") {
          const paused = await preview.evaluate((video) =>
            video.parentElement.getAnimations({ subtree: true }).every((a) => a.playState === "paused"),
          );
          if (!paused) throw new Error("Scanner ignored reduced motion");
          await p.emulateMedia({ reducedMotion: "no-preference" });
          await p.waitForFunction(() =>
            document
              .querySelector(".auth-camera-preview")
              .getAnimations({ subtree: true })
              .some((a) => a.playState === "running"),
          );
          await p.screenshot({ path: "output/playwright/pwa-qr-camera.png", fullPage: true });
        }
        if (mode === "stop") await p.getByRole("button", { name: "Stop camera", exact: true }).click();
        else await p.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        await p.getByRole("button", { name: mode === "pagehide" ? "Unlock" : "Scan QR code", exact: true }).waitFor();
      } else {
        await p.waitForFunction(() => window.cameraTest.tracks.length > 0);
        await p.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await p.getByRole("button", { name: "Unlock", exact: true }).waitFor();
        await p.evaluate(() => {
          delete document.visibilityState;
          document.dispatchEvent(new Event("visibilitychange"));
        });
      }
      await p.waitForFunction(() => window.cameraTest.tracks.every((t) => t.readyState === "ended"));
      if (apiCalls) throw new Error("Scanner contacted a Cloud without consent");
      results.push({ mode, stopped: true, noAutoTrust: apiCalls === 0, cameraCalls: await p.evaluate(() => window.cameraTest.calls) });
    } catch (error) {
      const diagnostic = await p.evaluate(() => ({
        secure: window.isSecureContext,
        mediaDevices: typeof navigator.mediaDevices,
        cameraCalls: window.cameraTest.calls,
        tracks: window.cameraTest.tracks.map((t) => t.readyState),
        captureStream: typeof HTMLCanvasElement.prototype.captureStream,
        videos: Array.from(document.querySelectorAll("video")).map((v) => ({
          width: v.videoWidth,
          height: v.videoHeight,
          state: v.readyState,
        })),
        alert: document.querySelector('[role="alert"]')?.textContent,
      }));
      throw new Error(mode + ": " + String(error) + " " + JSON.stringify({ ...diagnostic, browserErrors }));
    } finally {
      await context.close();
    }
  }
  return results;
}
