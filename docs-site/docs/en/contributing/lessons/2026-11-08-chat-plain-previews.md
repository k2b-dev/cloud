### Chat previews showed Markdown marks, and a settings hint's icon sat above its text

- **What happened:** The chat list, the side panel, For you, reply quotes and push texts showed a message as written, so `hi **wie geht** es dir?` kept its asterisks. In a chat's Info, the settings icon of the hint "Browser, email, and quiet hours: Settings › Notifications" sat above the text line.
- **Root cause:** `messagePreview` only collapsed whitespace in the Markdown source; an integration test even asserted the raw `**thread**`. The hint was a hand-built flex row whose small text button kept its own height and padding, so the text line moved down while the icon stayed at the top.
- **Error class:** Showing stored source (Markdown) where a reader expects rendered text; hand-built icon and text rows next to a shared inline pattern.
- **Guard:** `system-messages.test.ts` checks that previews contain only visible text (emphasis, links, code, lists, tables, entities). The hint uses `InlineGuidance` from `@k2b/ui`, and `ChatNotifications.browser.test.ts` measures that the icon's middle and the text's middle agree within 1 px.
