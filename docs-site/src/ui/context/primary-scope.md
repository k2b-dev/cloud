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
including selection, hover, focus, switches, and sliders. Light hover uses a
subtler plum surface than selection; dark hover keeps the neutral UI surface.

## Nested surfaces

Nested `.k2b-ui` roots keep the primary scope. Menus, dialogs, and floating
windows opened from the scoped area inherit it too. Each dialog level follows
its own opener; closing a nested level restores the previous level’s scope.
Keep the trigger inside the scope; programmatic opens use the currently focused
UI area. Notifications share one rail, with each toast retaining its source’s
scope, so blue and plum notifications can appear together.

The scope remaps the action, hover, selected, focus, link, row selection,
and workspace selection roles. It also updates text selection and inset focus
fills. Informational notices, default tags and choice pills, running status
badges, uncoloured timeline entries, and calendar dots also follow the scope.
Warning, error, and success colours retain their meaning.

Explicit object colours stay unchanged: file-type and avatar colours, colour
choices and presence colours, `tint-blue`,
`data-tone="blue"`, explicit blue calendar/timeline colours, chart series and data bars, syntax
colours, and the map’s location marker (`--k2b-map-me`).
