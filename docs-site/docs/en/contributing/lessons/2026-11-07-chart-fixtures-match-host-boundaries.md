### Chart fixtures must exercise the host they describe

- **What happened:** New line tests failed because a Chat fixture omitted its required title, an inspector fixture retained embedded SVG styles that Happy DOM could not parse, and a dashboard test searched for an external legend inside the drawing.
- **Root cause:** The fixtures did not match their schema, DOM environment or host structure. Assertions failed before reaching the behavior they were meant to protect.
- **Error class:** An invalid fixture masks the boundary under test.
- **Guard:** Marker fixtures include the required title and test both accepted domain endpoints. Inspector fixtures retain four marks in the original SVG and the parsed DOM, using the established style-free Happy DOM setup. Dashboard assertions locate the external legend in its frame and verify its Home/End values. A registry-driven line browser guard measures frame, title, subtitle and viewport across every state at 390 px; the existing showcase registry guard remains unchanged.
