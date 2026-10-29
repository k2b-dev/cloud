### Picker defaults got ahead of recipient contracts

- **What happened:** The inclusive picker offered inactive accounts and Grids published-app recipients that grant creation rejects.
- **Root cause:** Directory discovery defaults were reused without matching each resource's current recipient contract during PR slicing.
- **Error class:** Selection eligibility differs from mutation validation.
- **Guard:** PermissionEditor searches active accounts by default; API and DOM regressions cover filter forwarding, and SQL integration coverage checks eligibility before totals and pagination. Grids keeps its documented custom-app exclusion until its API accepts machine recipients.
