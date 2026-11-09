### Keep tool names consistent in privacy guidance

- **What happened:** The catalog renamed the speedtest, but the safety article retained its previous English and German names. Two Help tests also expected introduction sentences replaced by the new grouping guide.
- **Root cause:** Catalog labels and Help content were updated separately without running the Help tests.
- **Error class:** User guidance drifts from the names people see in the application.
- **Guard:** The Help suite checks every current category and tool name in both language guides. Its existing safety check still requires all four tools that send data to a server, and the article preserves their processing and retention explanations. Metadata and locale fallback checks remain in place.
