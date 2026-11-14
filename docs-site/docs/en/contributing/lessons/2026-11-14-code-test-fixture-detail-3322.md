### Mock reply refusals must identify the field to repair

- **What happened:** Gustav repeatedly changed a refused Spaces reply and submitted a version with no passing test.
- **Root cause:** The complete reply used `Itm0001` and `ColBacklog01`, but Spaces resource IDs require exactly six alphanumeric characters. Earlier replies also omitted required fields. The fake bridge correctly rejected the data but discarded the schema issue, leaving only `code_test_invalid_fixture`.
- **Error class:** Validation loses the location and reason needed to repair author-supplied data.
- **Guard:** The Spaces public test-bridge regression checks the reported ID failures and accepts the corrected complete reply with receipt replay. Platform tests cover reply types, forbidden pagination and FileRef limits; Core tests cover malformed JSON, fixture structure, simulation and bounded details. The authoring references require correcting the located field and passing tests before submission.
