import { expect, test } from "bun:test";
import { conversationFileSource } from "./file-source";

test("conversation file uploads preserve the selected directory",async()=>{
  const original=globalThis.fetch;
  const requests:Array<{path:string;directory:FormDataEntryValue|null;name:string}>=[];
  globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(!(init?.body instanceof FormData))throw new Error("Expected multipart upload");
    const file=init.body.get("file");
    if(!(file instanceof File))throw new Error("Expected file");
    requests.push({path:String(input),directory:init.body.get("directory"),name:file.name});
    return Response.json({file:{path:"/files/results-2.csv"}});
  },{preconnect:original.preconnect});
  try{
    await conversationFileSource("/api/ai","test-chat").upload!("/files",[new File(["x"],"results.csv")]);
    expect(requests).toEqual([{path:"/api/ai/conversations/test-chat/files",directory:"/files",name:"results.csv"}]);
  }finally{globalThis.fetch=original;}
});
