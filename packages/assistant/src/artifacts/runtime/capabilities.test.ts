import {expect,test,spyOn} from "bun:test";
import {artifactClient} from "../client";
import {runCapability} from "./capabilities";

test("capabilities.run preserves the public domain-data and reference envelope",async()=>{
  const envelope={data:{answer:42},refs:[{type:"example.record",id:"one"}]};
  const prepare=spyOn(artifactClient,"capabilityPrepare").mockResolvedValue({status:"completed",result:{ok:true,data:envelope}});
  try {
    const result=await runCapability("example.read",{}, {},async()=>{throw new Error("Read must not need approval");},new AbortController().signal);
    expect(result).toEqual(envelope);
  } finally {prepare.mockRestore();}
});
