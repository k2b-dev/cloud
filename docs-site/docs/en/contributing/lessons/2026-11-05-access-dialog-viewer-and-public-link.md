### Let the platform know the viewer instead of asking each app

- **What happened:** The access dialog marked the signed-in person "You" only where a caller passed `viewerUserId`; Spaces, Mail and every other app showed no mark. With public access on, Copy showed only an icon and the warning had neither an icon nor the warning color.
- **Root cause:** The dialog took the viewer as an optional prop although every Cloud page already names the signed-in person in its shell data. In `@k2b/ui`, `NoticeCard` gives the tone icon and ink only with an explicit `icon`, and a labelled `CopyButton` changed width between "Copy" and "Copied".
- **Error class:** A platform fact handed in as an optional prop, so callers that forget it silently lose the behavior.
- **Guard:** `AccessDialog.browser.test.ts` marks "You" from Spaces shell data with no viewer prop, and checks the public link's warning tone, icon, the visible Copy label and that Copied moves neither button nor field. `NoticeCard` `icon={true}` and the `CopyButton` width reservation have render tests.
