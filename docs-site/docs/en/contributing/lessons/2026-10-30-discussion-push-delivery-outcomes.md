### Discussion push must validate every exposed resource and report delivery outcomes

- **What happened:** Item readers could receive a container title without container access. A healthy provider or an interactive check could mask a failed delivery, and short retries exhausted inside the admission window.
- **Root cause:** Recipient preparation checked only the item, health used a single last-write-wins value before hand-off, and temporary admission and lock failures consumed short retry attempts.
- **Error class:** Incomplete authorization at an effect boundary; misleading shared health; retry policy shorter than the dependency recovery window.
- **Guard:** Chat notification delivery integration tests check item/container intersection, per-provider delivery health, expiry after fan-out, and bounded delayed resubmission. Platform reader and capability response tests preserve admission retry delays.
