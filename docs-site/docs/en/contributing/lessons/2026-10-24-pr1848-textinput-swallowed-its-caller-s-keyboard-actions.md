### TextInput swallowed its caller's keyboard actions

- **What happened:** Escape did not close Notebook map suggestions, and arrow keys could not select them.
- **Root cause:** The native input's internal submit handler replaced the caller's `onKeyDown` prop.
- **Error class:** An internal event handler overwrites a supported consumer handler.
- **Guard:** TextInput invokes function and bound-data keyboard handlers before its default submit behavior, respecting `defaultPrevented`. Native input/textarea behavior tests and the Notebook map browser flow cover the regression.
