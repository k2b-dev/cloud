### An app's own stylesheet squeezed names in the shared access dialog

- **What happened:** In Studio's share dialog on a 390 px phone, a Code account's name showed as "Cod…" and agents as "Rep…", while the shared dialog's own browser test looked right.
- **Root cause:** Each row's name used `flex-1 basis-40`. The global stylesheet orders `.basis-40` after `.flex-1`, but the Assistant's own utilities, loaded later, repeat `.flex-1` and reset the basis to zero, so the controls never wrapped below the name.
- **Error class:** A shared component that depends on the order of two utilities, which an application's own utility layer can reverse.
- **Guard:** The dialog uses one declaration, `flex-[1_1_10rem]`, and names wrap. `machine-permissions.browser.test.ts` loads the global and the Assistant stylesheet and asserts at 1280 and 390 px that Code titles are not clipped and nothing overflows.
