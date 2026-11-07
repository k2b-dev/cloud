# Primary scope

Set `data-k2b-primary="ai"` on a UI root or a subtree to use plum for its
primary actions, selection, links, and focus indicators. The surrounding UI
keeps its default blue primary colour.

```tsx
<main class="k2b-ui">
  <Button>Blue action</Button>
  <section data-k2b-primary="ai">
    <Button>Plum action</Button>
    <Switch label="Suggest a next step" value={enabled()} onValueChange={setEnabled} />
  </section>
</main>
```

Use this scope when an entire area represents AI work. For an individual AI
suggestion in an otherwise ordinary area, use the component's AI variant.

## Light and dark

The scope follows the UI theme. Light primary fills use `#8e1b6f` and white
labels. Dark primary fills use `#b7408f` and white labels, while primary text
uses `#f0abdc`. Selected surfaces use the existing AI surface token in each theme.
Use the site theme switch to compare light and dark in the demo below,
including selection, focus, switches, and sliders.

## Nested surfaces

Nested `.k2b-ui` roots keep the primary scope. Menus, dialogs, and floating
windows opened from the scoped area inherit it too. Keep the trigger inside
the scope; programmatic dialogs use the currently focused UI area.

The scope remaps the action, hover, selected, focus, link, row selection,
and workspace selection roles. It also updates text selection and inset focus
fills. Status colours and explicit object or file-type colours retain their
meaning.
