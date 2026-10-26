### Month rows keep a stale place in WebKit

- **What happened:** In WebKit, the continuous month view sometimes kept its server-rendered week rows at an old place and height for up to a second after mount, and the WebKit gate flaked on it ([#1132](https://github.com/k2b-dev/cloud/issues/1132)).
- **Root cause:** Row place and height depended on container query units of a size container. WebKit did not always resolve the container units again after mount, so the server-rendered rows kept their old place and height until a later restyle.
- **Error class:** Server render vs. mount.
- **Guard:** Since [#1157](https://github.com/k2b-dev/cloud/pull/1157), rows take their size from the scroller, and browser tests in `@k2b/ui` and Spaces check each row's place right after mount.
