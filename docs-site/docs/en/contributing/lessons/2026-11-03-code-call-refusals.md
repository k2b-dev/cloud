### Preserve status when reporting Code call refusals

- **What happened:** The runner bridge dropped capability dispatch HTTP status. The Code page guessed access refusals from code substrings, so an unrelated failure such as `ACCESS_LOOKUP_FAILED` counted as missing access.
- **Root cause:** The bridge retained only a lowercase code, while the page treated the code spelling as a classification contract. Spaces itself returns `NOT_FOUND`; `spaceNotFound` is its translation key.
- **Error class:** Transport metadata lost before downstream classification.
- **Guard:** The capability API regression passes real application error shapes through dispatch and the runner result schema into Code page data. The bridge integration regression checks SQL storage, and the page classifier tests require exactly HTTP 403/404; missing status stays unclassified.
