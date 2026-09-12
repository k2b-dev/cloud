import { parseCodeToolInput } from "@k2b/cloud/ai/browser";
import { createCliCodeHost } from "./code-host";
import { resolveConversation } from "./turn";
import { arg, command, flag, readCliInput } from "@k2b/cloud/cli";
import { z } from "zod";
import { jsonRequest, parseJson, printValue, queryString, readAssistantApi, requireConfirmation } from "./shared";
import { DatabaseSql } from "../artifacts/database-contracts";
import { ArtifactKind } from "../artifacts/contracts";
import type { ArtifactBundle } from "../artifacts/service";

const resource=arg.required({valueLabel:"resource-id"});
const path=(id:string,suffix="")=>`/artifacts/${encodeURIComponent(z.uuid().parse(id))}${suffix}`;
const jsonInput=async(input:Parameters<typeof readCliInput>[0])=>parseJson(await readCliInput(input,{label:"JSON input",required:true})??"","input");
const inputFlag=()=>flag.input({description:"JSON input; use --input-file or stdin, especially for secrets"});

export const assistantCodeCommands=[
  command("code database-status",{summary:"Read resource database status without creating it (Manage access)",args:{id:resource},async run({ctx,args}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/database/status")));
  }}),
  command("code database-reset",{summary:"Detach the database and queue deletion; source and files/KV are preserved",args:{id:resource},flags:{yes:flag.boolean()},async run({ctx,args,flags}){
    requireConfirmation(flags.yes,"Resetting the shared database");
    const status=await readAssistantApi<{generation:string|null}>(ctx,path(args.id,"/database/status"));
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/database/reset"),jsonRequest("POST",{confirmed:true,expectedGeneration:status.generation})));
  }}),
  command("code database-export",{summary:"Download a SQLite backup (Manage access)",args:{id:resource},flags:{out:flag.string({required:true})},async run({ctx,args,flags}){
    const response=await ctx.fetch("/api/assistant"+path(args.id,"/database/export"));
    if(!response.ok)await ctx.readJson(response);
    if(!flags.out)throw new Error("Provide --out for the SQLite backup.");
    await Bun.write(flags.out,response);
    printValue(ctx,{out:flags.out});
  }}),
  command("code storage-manage",{summary:"Inspect or delete shared files/KV as a resource manager",args:{id:resource},flags:{input:inputFlag()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/storage/manage"),jsonRequest("POST",await jsonInput(flags.input))));
  }}),
  command("code storage-clear",{summary:"Clear shared files, KV or both; database and source stay unchanged",args:{id:resource},flags:{area:flag.string({required:true}),yes:flag.boolean()},async run({ctx,args,flags}){
    requireConfirmation(flags.yes,"Clearing shared storage");
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/storage/clear"),jsonRequest("POST",{area:z.enum(["files","kv","all"]).parse(flags.area),confirmed:true})));
  }}),
  command("code run",{summary:"Execute code in an isolated CLI worker, optionally with UI interactions and output exports",flags:{
    chat:flag.string({description:"Existing chat ID for authorized inputs, outputs and Project context"}),
    input:inputFlag(),steps:flag.input({description:"Optional JSON array of {name,args} steps: code_interact, code_inspect, code_export"}),
    approve:flag.stringList({description:"Explicitly approve this exact capability name for this run"}),
  },async run({ctx,flags}){
    if(!flags.chat)throw new Error("Provide --chat with an existing chat ID for the run context.");
    const input=await jsonInput(flags.input);
    parseCodeToolInput("code_run",input);
    const stepsText=await readCliInput(flags.steps,{label:"Run steps"});
    const steps=z.array(z.object({name:z.enum(["code_interact","code_inspect","code_export"]),args:z.record(z.string(),z.json())}).strict())
      .parse(stepsText ? parseJson(stepsText,"run steps") : []);
    const conversation=await resolveConversation(ctx,{conversationId:flags.chat});
    const host=await createCliCodeHost(ctx,async request=>{
      if(flags.approve?.includes(request.name))return {approved:true};
      throw new Error(`Capability ${request.name} needs approval. Use an interactive Assistant chat or explicitly authorize it with --approve.`);
    });
    const runId=crypto.randomUUID(),base={conversationId:conversation.id,turnId:crypto.randomUUID()};
    try {
      const results:unknown[]=[];
      const first=await host.execute({...base,callId:runId,name:"code_run",args:input});
      results.push(first);
      if(first && typeof first==="object" && "error" in first && first.error)throw new Error(JSON.stringify(first));
      for(const step of steps){
        const args={...step.args,runId};
        parseCodeToolInput(step.name,args);
        const result=await host.execute({...base,callId:crypto.randomUUID(),name:step.name,args});
        results.push(result);
        if(result && typeof result==="object" && "error" in result && result.error)throw new Error(JSON.stringify(result));
      }
      // Keep the CLI host alive for a background job, including jobs started by
      // the last interaction. Intermediate snapshots are not completed results.
      const running = (value: unknown) => value && typeof value === "object" && "work" in value
        && value.work && typeof value.work === "object" && "status" in value.work && value.work.status === "running";
      let latest = results.at(-1);
      if (running(latest)) {
        do {
          latest = await host.execute({...base,callId:crypto.randomUUID(),name:"code_inspect",args:{runId,waitMs:30000}});
          if(latest && typeof latest==="object" && "error" in latest && latest.error)throw new Error(JSON.stringify(latest));
          if(latest && typeof latest==="object" && "modal" in latest && latest.modal)throw new Error("Background job is waiting for a dialog. Supply a code_interact step to answer it.");
        } while (running(latest));
        results.push(latest);
      }
      printValue(ctx,results.length===1 ? first : results);
    } finally {await host.close();}
  }}),
  command("code list",{summary:"List accessible apps and saved scripts; optionally in a Project chat context",flags:{kind:flag.string(),search:flag.string(),page:flag.string(),conversation:flag.string()},async run({ctx,flags}){
    printValue(ctx,await readAssistantApi(ctx,"/artifacts"+queryString({kind:flags.kind,q:flags.search,page:flags.page,conversationId:flags.conversation})));
  }}),
  command("code create",{summary:"Create a private app or saved script",args:{title:arg.required()},flags:{kind:flag.string(),description:flag.string(),icon:flag.string()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,"/artifacts",jsonRequest("POST",{title:args.title,kind:ArtifactKind.parse(flags.kind??"app"),description:flags.description,icon:flags.icon,source:{entry:"main.ts",files:[{path:"main.ts",content:"export default () => {};\n"}]}})));
  }}),
  command("code get",{summary:"Read source and metadata; Project context grants read/run only",args:{id:resource},flags:{conversation:flag.string(),version:flag.string()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id)+queryString({conversationId:flags.conversation,version:flags.version})));
  }}),
  command("code write",{summary:"Write one complete source file and save immediately, preserving other files",args:{id:resource,path:arg.required({valueLabel:"source-path"})},flags:{content:flag.input({description:"Source text; use --content-file or stdin"})},async run({ctx,args,flags}){
    const content=await readCliInput(flags.content,{label:"Source content",required:true});
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/files"),jsonRequest("PUT",{path:args.path,content})));
  }}),
  command("code update",{summary:"Replace source and metadata using the same revision check as the GUI",args:{id:resource},flags:{input:inputFlag()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id),jsonRequest("PUT",await jsonInput(flags.input))));
  }}),
  command("code publish",{summary:"Publish the current source; sharing stays unchanged",args:{id:resource},flags:{note:flag.input({description:"Publication note; Initial release is used for the first publication"})},async run({ctx,args,flags}){
    const current=await readAssistantApi<ArtifactBundle>(ctx,path(args.id));
    const versions=await readAssistantApi<{items:unknown[]}>(ctx,path(args.id,"/versions"));
    const note=versions.items.length ? await readCliInput(flags.note,{label:"Publication note",required:true}) : "Initial release";
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/publish"),jsonRequest("POST",{expectedRevision:current.revision,note})));
  }}),
  command("code unpublish",{summary:"Withdraw the published version from non-admin users",args:{id:resource},async run({ctx,args}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/unpublish"),jsonRequest("POST")));
  }}),
  command("code fork",{summary:"Copy a publication into a private draft with empty storage",args:{id:resource},async run({ctx,args}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/fork"),jsonRequest("POST")));
  }}),
  command("code delete",{summary:"Permanently delete a resource you manage and its shared data",args:{id:resource},flags:{yes:flag.boolean()},async run({ctx,args,flags}){
    requireConfirmation(flags.yes,"Deleting a resource");
    printValue(ctx,await readAssistantApi(ctx,path(args.id),jsonRequest("DELETE")));
  }}),
  command("code edit-chat",{summary:"Create a new unsent editing chat for a resource",args:{id:resource},async run({ctx,args}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/edit-chat"),jsonRequest("POST")));
  }}),
  command("code versions",{summary:"List publications",args:{id:resource},flags:{page:flag.string()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/versions")+queryString({page:flags.page})));
  }}),
  command("code restore",{summary:"Restore a publication as a new latest version, preserving app data",args:{id:resource,version:arg.required()},async run({ctx,args}){
    const current=await readAssistantApi<ArtifactBundle>(ctx,path(args.id));
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/restore"),jsonRequest("POST",{version:Number(args.version),expectedRevision:current.revision})));
  }}),
  command("code projects",{summary:"List Project associations for a script",args:{id:resource},async run({ctx,args}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/projects")));
  }}),
  command("code project-link",{summary:"Link or unlink a script; requires script and Project administration",args:{id:resource,project:arg.required()},flags:{remove:flag.boolean()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/projects/"+encodeURIComponent(args.project)),jsonRequest("PUT",{linked:!flags.remove})));
  }}),
  command("code access",{summary:"Read resource grants",args:{id:resource},async run({ctx,args}){printValue(ctx,await readAssistantApi(ctx,path(args.id,"/access")));}}),
  command("code grant",{summary:"Add a canonical user/group grant: {principal,permission}",args:{id:resource},flags:{input:inputFlag()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/access"),jsonRequest("POST",await jsonInput(flags.input))));
  }}),
  command("code change-grant",{summary:"Change or remove a grant: {permission:read|admin|null}",args:{id:resource,access:arg.required()},flags:{input:inputFlag()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/access/"+encodeURIComponent(args.access)),jsonRequest("PUT",await jsonInput(flags.input))));
  }}),
  command("code storage",{summary:"Read/write/list/delete shared files or KV using {area,operation,key,content}",args:{id:resource},flags:{input:inputFlag(),conversation:flag.string()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/storage")+queryString({conversationId:flags.conversation}),jsonRequest("POST",await jsonInput(flags.input))));
  }}),
  command("code sql",{summary:"Run a read-only SELECT against an existing resource database; never creates one",args:{id:resource},flags:{input:inputFlag(),conversation:flag.string()},async run({ctx,args,flags}){
    const input=DatabaseSql.parse(await jsonInput(flags.input));
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/database")+queryString({conversationId:flags.conversation}),jsonRequest("POST",{operation:"query",...input})));
  }}),
  command("code database-connect",{summary:"Lazily connect the resource database; fails if rsql is not configured",args:{id:resource},flags:{conversation:flag.string()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/database/connect")+queryString({conversationId:flags.conversation}),jsonRequest("POST")));
  }}),
  command("code database",{summary:"Run SELECT or a structured schema/row operation on the connected database",args:{id:resource},flags:{input:inputFlag(),conversation:flag.string()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,path(args.id,"/database")+queryString({conversationId:flags.conversation}),jsonRequest("POST",await jsonInput(flags.input))));
  }}),
  command("studio-admin list",{summary:"List all apps/scripts and shared storage counts as an administrator",flags:{page:flag.string(),search:flag.string()},async run({ctx,flags}){
    printValue(ctx,await readAssistantApi(ctx,"/artifacts/admin/resources"+queryString({page:flags.page,search:flags.search})));
  }}),
  command("studio-admin delete",{summary:"Delete a resource, its publications and shared data",args:{id:resource},flags:{yes:flag.boolean()},async run({ctx,args,flags}){
    requireConfirmation(flags.yes,"Deleting a resource");
    printValue(ctx,await readAssistantApi(ctx,"/artifacts/admin/resources/"+encodeURIComponent(args.id),jsonRequest("DELETE")));
  }}),
  command("studio-admin settings",{summary:"Read rsql settings with a redacted token",async run({ctx}){printValue(ctx,await readAssistantApi(ctx,"/artifacts/admin/database/settings"));}}),
  command("studio-admin configure",{summary:"Configure rsql through secret-aware settings; supply JSON through a private file or stdin",flags:{input:inputFlag(),test:flag.boolean()},async run({ctx,flags}){
    printValue(ctx,await readAssistantApi(ctx,"/artifacts/admin/database/"+(flags.test?"test":"settings"),jsonRequest(flags.test?"POST":"PUT",await jsonInput(flags.input))));
  }}),
  command("studio-admin access",{summary:"Read any resource's grants as administrator",args:{id:resource},async run({ctx,args}){printValue(ctx,await readAssistantApi(ctx,"/artifacts/admin/resources/"+encodeURIComponent(args.id)+"/access"));}}),
  command("studio-admin grant",{summary:"Grant access to any resource as administrator",args:{id:resource},flags:{input:inputFlag()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,"/artifacts/admin/resources/"+encodeURIComponent(args.id)+"/access",jsonRequest("POST",await jsonInput(flags.input))));
  }}),
  command("studio-admin change-grant",{summary:"Change or remove any resource grant as administrator",args:{id:resource,access:arg.required()},flags:{input:inputFlag()},async run({ctx,args,flags}){
    printValue(ctx,await readAssistantApi(ctx,"/artifacts/admin/resources/"+encodeURIComponent(args.id)+"/access/"+encodeURIComponent(args.access),jsonRequest("PUT",await jsonInput(flags.input))));
  }}),
];
