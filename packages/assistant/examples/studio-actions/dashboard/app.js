// Display only: the published setStatus action maintains the value.
const status = await cloud.kv.get("status");
document.querySelector("#status").textContent = status?.message ?? "No status published yet.";
