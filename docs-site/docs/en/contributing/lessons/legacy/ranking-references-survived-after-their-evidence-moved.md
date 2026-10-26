### Ranking references survived after their evidence moved

- **What happened:** The performance ranking accepted blank source rows or unrelated code at a previously valid location ([#1472](https://github.com/k2b-dev/cloud/issues/1472)).
- **Root cause:** Validation checked only that the file existed and the line number was in range.
- **Error class:** A source location is valid but no longer names its evidence.
- **Guard:** Ranking candidates require a matching complete source-line anchor. Tests reject blank, changed and moved lines, missing anchors, and internal or surrounding line breaks while preserving measured-metric checks.
