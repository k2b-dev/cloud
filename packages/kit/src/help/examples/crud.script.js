export default kit.script({
  name: "Tasks",
  async run() {
    const table = kit.db.table("example_tasks");
    let rows = [], offset = 0;
    const status = kit.ui.status("Loading…");
    const list = kit.ui.list({ title: "Tasks", empty: { title: "No matching tasks", description: "Add a task or change the filter." } }, []);
    const filter = kit.ui.select("Status", [
      { value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "done", label: "Done" }
    ], "all");
    // Create actions only for visible rows; reuse them across pages.
    const actions = [];
    const action = i => actions[i] ??= kit.ui.row({}, [
      kit.ui.button("Edit", () => change(() => edit(rows[i]))),
      kit.ui.button("Delete", () => change(async () => {
        const task = rows[i];
        if (await kit.ui.modal.confirm({ title: "Delete task", message: `Delete “${task.title}”?`, variant: "danger" })) {
          await table.rows.delete(task.id);
          await load();
        }
      }), { variant: "danger" })
    ]);
    const back = kit.ui.button("Previous", () => change(async () => { offset = Math.max(0, offset - 10); await load(); }));
    const next = kit.ui.button("Next", () => change(async () => { offset += 10; await load(); }));
    kit.ui.workbench({
      controls: [filter,
        kit.ui.button("Apply", () => change(async () => { offset = 0; await load(); })),
        kit.ui.button("Add task", () => change(() => edit()), { variant: "primary" })],
      content: [list], footer: { status, actions: [back, next, kit.ui.button("Refresh", () => change(load))] }
    });
    async function change(work) {
      status.setState("loading");
      try { await work(); status.setState("ready"); }
      catch (error) { status.set(error.message); status.setState("error"); }
    }
    async function load() {
      const value = filter.getValue();
      const { data } = await table.rows.list({ limit: 11, offset, order: "id.asc", ...(value === "all" ? {} : { status: `eq.${value}` }) });
      if (!data.length && offset > 0) { offset = Math.max(0, offset - 10); return load(); }
      rows = data.slice(0, 10);
      list.set(rows.map((task, i) => ({ id: String(task.id), title: task.title, description: task.status, action: action(i) })));
      back.setDisabled(offset === 0); next.setDisabled(data.length <= 10);
      status.set(`${rows.length} tasks · Page ${offset / 10 + 1}`);
    }
    async function edit(task) {
      const values = await kit.ui.modal.dialog({ title: task ? "Edit task" : "Add task", fields: {
        title: { type: "text", label: "Title", required: true, maxLength: 200, default: task?.title ?? "" },
        status: { type: "select", label: "Status", default: task?.status ?? "open", options: [{ value: "open", label: "Open" }, { value: "done", label: "Done" }] }
      } });
      if (values === null) return;
      if (task) await table.rows.update(task.id, values);
      else await table.rows.insert(values);
      await load();
    }
    await change(load);
  }
});
