### Discussion places named their next page only for Chat

- **What happened:** On the preview, Chat's discussion list said that some places could not be loaded, and address books and bases never appeared, because the next branch skipped `book.containers` and `base.containers`.
- **Root cause:** Every discussion provider returned its continuation only as `data.next`, without the capability `page`. Chat follows `data.next`, so `main` looked fine, while agents and the Code SDK follow `page` and stopped after the first page. A stricter rule on the next branch rejected such pages; Notebooks and Spaces were fixed there only, and Contacts, Grids and Files arrived later without the fix.
- **Error class:** One continuation stated twice by convention, with no platform check that both statements agree.
- **Guard:** The platform rejects a discussion containers page whose `page` does not match `data.next` (`validateCapabilityResult`), every built-in provider asserts it with `assertDiscussionContainersPage`, and `tests/discussion-containers-contract.test.ts` fails when a provider in the workspace does not.
