### The access dialog's service-account section drifted from the approved mockup

- **What happened:** The Code lane compared its Studio sharing against the approved rights-editor mockup (v31) and found the shared access dialog on `main` off in the **Service accounts** section. The identifier field said "Paste the identifier" instead of naming where the identifier comes from. There was no empty text. A two-sentence explanation always showed instead of the mockup's one note under the rows. The accounts of objects showed a robot instead of the code icon.
- **Root cause:** The section was built from the concept text instead of the published mockup, and no test pinned the mockup's wording or icon.
- **Error class:** UI copy and icons of an approved mockup reach the build only by reading, without a test that holds them.
- **Guard:** `AccessDialog.behavior.test.tsx` asserts the mockup's hint in the identifier field, empty text, single note with the resource name, that neither shows while adding, and the code icon for an object's account.
