// Disposable Postgres and rsql: never connect these tests to the development database.
const name = `assistant-artifact-test-${crypto.randomUUID()}`;
async function docker(...args: string[]) {
  const child=Bun.spawn(["docker",...args],{stdout:"pipe",stderr:"pipe"});
  const [output,error,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(status)throw new Error(error);
  return output.trim();
}
let created=false, rsqlCreated=false;
try {
  await docker("run","--detach","--name",name,"--env","POSTGRES_HOST_AUTH_METHOD=trust","--env","POSTGRES_DB=cloud_assistant_artifacts_test","--publish","127.0.0.1::5432","--tmpfs","/var/lib/postgresql/data","postgres:17-alpine");
  created=true;
  for(let attempt=0;;attempt++) {
    try {await docker("exec",name,"pg_isready","-h","127.0.0.1","-U","postgres");break;}
    catch(error){if(attempt>=60)throw error;await Bun.sleep(250);}
  }
  const port=(await docker("port",name,"5432/tcp")).split(":").at(-1);
  const rsqlName=name+"-rsql";
  await docker("run","--detach","--name",rsqlName,"--env","RSQL_API_TOKEN=artifact-test-only","--publish","127.0.0.1::8080","--tmpfs","/data:uid=1000,gid=1000,mode=0700","--entrypoint","/usr/local/bin/rsql","ghcr.io/k2b-dev/rsql:1.0.0","serve","--listen=0.0.0.0:8080","--data-dir=/data");
  rsqlCreated=true;
  const rsqlPort=(await docker("port",rsqlName,"8080/tcp")).split(":").at(-1);
  const rsqlUrl=`http://127.0.0.1:${rsqlPort}`;
  for(let attempt=0;;attempt++){
    try {const response=await fetch(rsqlUrl+"/healthz");if(!response.ok)throw new Error("rsql unhealthy");break;}
    catch(error){if(attempt>=60)throw error;await Bun.sleep(250);}
  }
  const child=Bun.spawn([process.execPath,"--no-env-file","test","--timeout","20000",new URL("../src/artifacts/service.integration.test.ts",import.meta.url).pathname],{
    env:{PATH:process.env.PATH,ASSISTANT_EVAL_FILES:process.env.ASSISTANT_EVAL_FILES,ASSISTANT_EVAL_URL:process.env.ASSISTANT_EVAL_URL,ASSISTANT_EVAL_TOKEN:process.env.ASSISTANT_EVAL_TOKEN,ASSISTANT_EVAL_MODEL:process.env.ASSISTANT_EVAL_MODEL,NODE_ENV:"test",DATABASE_URL:`postgres://postgres@127.0.0.1:${port}/cloud_assistant_artifacts_test`,APP_SECRET:"51".repeat(32),RSQL_TEST_URL:rsqlUrl},stdout:"inherit",stderr:"inherit",
  });
  process.exitCode=await child.exited;
} catch(error) { if(rsqlCreated)console.error(await docker("logs",name+"-rsql")); throw error; } finally {if(rsqlCreated)await docker("rm","--force","--volumes",name+"-rsql");if(created)await docker("rm","--force","--volumes",name);}
