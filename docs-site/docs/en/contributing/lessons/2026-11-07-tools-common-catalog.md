### A utility has one place in every navigation surface

- **What happened:** Tools used one grouping in its sidebar and a different grouping on its start page. German pages also displayed English application titles.
- **Root cause:** Separate category and task-group fields described the same catalog, while page and phone labels bypassed the message catalog.
- **Error class:** Duplicated navigation models and untranslated application chrome.
- **Guard:** Tools registry render tests check all five ordered groups, the four shortcuts, complete German messages, and server-rendered search results with a recovery action. The browser test checks search, reload, clearing, focus recovery, and narrow-width geometry. The production Tools build guards the SSR-owned workspace boundary: browser islands must not import other islands through layout modules.
