import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const input = process.env.BACKTEST_FILE ?? process.argv[2];
const outDir = process.env.BATCH_REPORT_DIR ?? "reports/luna-15m";
if (!input) {
  console.error("Usage: BACKTEST_FILE=/path/to/file.csv npm run batch:15m");
  process.exit(1);
}

function filesIn(p:string): string[] {
  const st=fs.statSync(p);
  if(st.isFile()) return [p];
  return fs.readdirSync(p,{withFileTypes:true})
    .flatMap(e=>filesIn(path.join(p,e.name)))
    .filter(f=>/\.csv$/i.test(f));
}
const files=filesIn(input).sort();
fs.mkdirSync(outDir,{recursive:true});

type Row={file:string,status:string,rows?:number,sha256?:string,stdout?:string,stderr?:string};
const rows:Row[]=[];
for(const file of files){
  const abs=path.resolve(file);
  const sha=crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  const result=spawnSync("npx",["tsx","src/replay-15m.ts"],{
    cwd:path.resolve("luna-th1h"),
    env:{...process.env,BACKTEST_FILE:abs},
    encoding:"utf8"
  });
  const stdout=result.stdout??"", stderr=result.stderr??"";
  const lines=stdout.trim().split(/\r?\n/);
  let parsed:any=null;
  try{ parsed=JSON.parse(lines[lines.length-1]); }catch{}
  const reportName=path.basename(file).replace(/\.csv$/i,"")+".json";
  fs.writeFileSync(path.join(outDir,reportName),JSON.stringify({source_file:abs,source_sha256:sha,run_at:new Date().toISOString(),result:parsed,stdout,stderr},null,2));
  rows.push({file:abs,status:result.status===0?"ok":"error",sha256:sha,rows:parsed?.rows,stdout,stderr});
}
fs.writeFileSync(path.join(outDir,"batch-manifest.json"),JSON.stringify({
  generated_at:new Date().toISOString(),files:rows.length,results:rows.map(r=>({...r,stdout:undefined,stderr:undefined}))
},null,2));
console.log(JSON.stringify({files:rows.length,ok:rows.filter(r=>r.status==="ok").length,errors:rows.filter(r=>r.status!=="ok").length,out_dir:path.resolve(outDir),manifest:path.resolve(outDir,"batch-manifest.json")},null,2));
