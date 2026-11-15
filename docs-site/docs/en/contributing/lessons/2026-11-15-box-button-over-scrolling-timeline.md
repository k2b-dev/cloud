### The box button floated over the scrolling chat on phones

- **What happened:** Below 56rem, and whenever tabs were open, the button “In diesem Chat” sat absolutely at the top of the chat. On a phone it covered message text as the history scrolled under it (rundgang finding 17), and the chat's title appeared nowhere. Its phone sheet opened at half height with empty space and dimmed the chat, unlike v12 picture 66.
- **Root cause:** #3385 kept the first message clear with top padding on the timeline content. Padding protects only the scroll start; every later scroll position passed under the button. The sheet used `detents`, which always opens at half height.
- **Error class:** An overlay kept clear of scrolling content with padding instead of its own layout space.
- **Guard:** `AssistantChatSidebar.browser.test.ts` scrolls the timeline to its middle at 390, 820 and 1280 px (tabs open) and requires the scrollport to start below the button; on a phone it requires the chat's title in the head row. The sheet test requires a sheet as high as the box and a backdrop without dimming or blur.
