import { render } from "solid-js/web";
import Admin from "./Admin.island";
render(() => <Admin search="" initial={{page:1,hasNext:false,items:[{
  id:"00000000-0000-4000-8000-000000000001",title:"Analysis script",kind:"app",files:2,kv:3,bytes:100,database:true,published:true,projects:["00000000-0000-4000-8000-000000000002"],
}]}} />, document.getElementById("root")!);
