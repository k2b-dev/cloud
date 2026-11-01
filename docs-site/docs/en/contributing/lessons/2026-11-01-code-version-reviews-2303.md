### Compile the owning capability manifest before shipping new policy Actions

- **What happened:** New Code Actions omitted required reviews, preventing the entire Core capability manifest and image from starting. Their nested inputs also lacked German presentation.
- **Root cause:** Typechecking did not exercise capability compilation, and the blocked focused test rerun left the complete manifest unverified.
- **Error class:** Declarative runtime contracts and translated metadata are assumed from static types instead of verified at their public seam.
- **Guard:** The Core capability test requires a review on every Code Action with policy and compiles the complete manifest. Built-in presentation and provider-schema tests cover all operations, and Code integration tests validate deterministic, non-mutating reviews and JSON-object storage for submission and decision bindings.
