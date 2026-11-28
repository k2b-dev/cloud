### Pictures of app screens showed a broken logo in the Cloud shell

- **What happened:** Every picture that put an app's screens in the real Cloud shell showed a broken image where the logo belongs, top left in the rail (lanes Y and W5, Pulse and Venue).
- **Root cause:** `Layout` draws `<img src="/branding/logo">`. In a running Cloud, Core serves that address. The test servers of the pictures did not, so the image failed with a 404. Each app had its own copy of the shell fixture, and each copy had the same gap.
- **Error class:** A test page that draws real shell markup but leaves out an address that only Core serves.
- **Guard:** `tests/fixtures/cloud-shell.ts` (`renderCloudShell`) is the one shell for pictures. Its page carries Cloud's own logo (`packages/cloud/public/logo.svg`) as a data URL in place of `/branding/logo`. `tests/cloud-shell.browser.test.ts` checks in Chromium and WebKit that every image of the shell loads (`naturalWidth > 0`). Without the logo in place, the test fails. Apps import this fixture instead of keeping a copy.
