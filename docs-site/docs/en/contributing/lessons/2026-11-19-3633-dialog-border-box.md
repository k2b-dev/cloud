### A held dialog missed changes to its content's outer size

- **What happened:** Adding fractional padding to content in an open dialog left its body at 176 px while its scroll height grew to 177 px. Releasing the held frame gave the body its natural 176.984375 px and removed the overflow.
- **Root cause:** The frame followed content-box size reports. Padding and borders can change the required outer height without changing that content box, so no new measurement was scheduled.
- **Error class:** Incomplete observation of intrinsic geometry.
- **Guard:** `packages/ui/test/dialog-border-box.behavior.test.ts` changes fractional theme edges while keeping the reported content box constant. `packages/ui/src/feedback/dialog-height.browser.test.ts` checks fractional padding in both themes against natural frame height and requires zero body overflow. Observers watch border boxes and compare border-box reports against baselines in the same units.
