### The access dialog told an empty list "Only you have access"

- **What happened:** The shared access dialog showed "Only you have access so far." when its list of people, groups, and agents was empty. Files v2 opens it for templates, which give nobody implicit access, and administrators open it for resources they are not listed on. In both cases the sentence claimed access that did not exist (found in the sol review of the Files v2 migration).
- **Root cause:** The empty state assumed the person editing is always one of the resource's managers, which is true only for resources whose creator is stored as a manager.
- **Error class:** A shared component's copy states a viewer-specific fact that only some callers make true.
- **Guard:** The empty state now says "Nobody is listed yet." without a claim about the viewer. `AccessDialog.behavior.test.tsx` renders an empty list and fails if "Only you" appears again.
