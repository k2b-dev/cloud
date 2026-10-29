### An empty shared status row shifted a note on hydration

- **What happened:** Replacing the Notebook preview with the shared editor moved every text line and chart down by 24 px.
- **Root cause:** The editor reserved an empty status row even when the host supplied its own presentation and no shared status.
- **Error class:** Adding component chrome above a host-owned content surface during hydration.
- **Guard:** The existing Notebook preview browser tests compare line, glyph and chart positions within 1 px. Host DOM tests retain table warnings while omitting the unused row; hosts supplying status keep its reserved space.
