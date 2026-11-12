import {createClient} from "@supabase/supabase-js";
import {S3Client,GetObjectCommand} from "@aws-sdk/client-s3";
import {createHash} from "node:crypto";
import {Readable} from "node:stream";
import {createGunzip} from "node:zlib";
import {createInterface} from "node:readline";

const objectKey=process.env.LUNA_ARCHIVE_OBJECT_KEY??"";
const supabaseUrl=process.env.SUPABASE_URL??"";
const serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY??"";
const accountId=process.env.R2_ACCOUNT_ID??"";
const accessKeyId=process.env.R2_ACCESS_KEY_ID??"";
const secretAccessKey=process.env.R2_SECRET_ACCESS_KEY??"";
const bucket=process.env.R2_BUCKET_NAME??"";
const confirmation=process.env.LUNA_ARCHIVE_RESTORE_CONFIRM??"";
if(!objectKey||!supabaseUrl||!serviceRoleKey||!accountId||!accessKeyId||!secretAccessKey||!bucket){
  throw new Error("Archive object key, Supabase service credentials and R2 credentials are required");
}
if(confirmation!=="RESTORE_VERIFIED_ARCHIVE"){
  throw new Error("Set LUNA_ARCHIVE_RESTORE_CONFIRM=RESTORE_VERIFIED_ARCHIVE only after approving a restore");
}
const db=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const s3=new S3Client({region:"auto",endpoint:`https://${accountId}.r2.cloudflarestorage.com`,forcePathStyle:true,credentials:{accessKeyId,secretAccessKey}});

async function getManifest(key:string){
  const {data:archive,error}=await db.from("luna_research_archives").select("*").eq("object_key",key).single();
  if(error) throw error;
  if(archive.status!=="VERIFIED"&&archive.status!=="RESTORE_VERIFIED") throw new Error("ARCHIVE_NOT_READBACK_VERIFIED");
  const response=await s3.send(new GetObjectCommand({Bucket:bucket,Key:archive.manifest_key}));
  if(!response.Body) throw new Error("ARCHIVE_MANIFEST_BODY_MISSING");
  const manifest=JSON.parse(await response.Body.transformToString()) as {
    dataset_id:string;row_count:number;source_sha256_uncompressed_ndjson:string;object_key:string;
  };
  if(manifest.object_key!==key||manifest.dataset_id!==archive.dataset_id) throw new Error("ARCHIVE_MANIFEST_IDENTITY_MISMATCH");
  return {archive,manifest};
}
async function verifyStream(key:string,expectedRows:number,expectedHash:string){
  const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
  if(!object.Body) throw new Error("ARCHIVE_OBJECT_BODY_MISSING");
  const stream=(object.Body as Readable).pipe(createGunzip());
  const hash=createHash("sha256");
  let rows=0,lastByte=10;
  for await(const part of stream){
    const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
    hash.update(chunk);
    for(const byte of chunk) if(byte===10) rows++;
    if(chunk.length) lastByte=chunk[chunk.length-1];
  }
  const actualHash=hash.digest("hex");
  if(lastByte!==10||rows!==expectedRows||actualHash!==expectedHash){
    throw new Error(`ARCHIVE_RESTORE_PREFLIGHT_FAILED:rows=${rows}:sha256=${actualHash}`);
  }
}
async function main(){
  const {archive,manifest}=await getManifest(objectKey);
  await verifyStream(objectKey,Number(manifest.row_count),manifest.source_sha256_uncompressed_ndjson);
  console.log(JSON.stringify({event:"ARCHIVE_RESTORE_PREFLIGHT_PASSED",object_key:objectKey,row_count:manifest.row_count}));

  const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:objectKey}));
  if(!object.Body) throw new Error("ARCHIVE_OBJECT_BODY_MISSING");
  const lines=createInterface({input:(object.Body as Readable).pipe(createGunzip()),crlfDelay:Infinity});
  let batch:Record<string,unknown>[]=[];
  let restored=0;
  for await(const line of lines){
    if(!line) continue;
    const row=JSON.parse(line) as Record<string,unknown>;
    // Identity IDs are intentionally regenerated; no foreign keys reference this source table.
    delete row.id;
    batch.push(row);
    if(batch.length>=500){
      const {error}=await db.from("luna_research_prices").upsert(batch,{onConflict:"dataset_id,symbol,date"});
      if(error) throw error;
      restored+=batch.length;
      batch=[];
      if(restored%25000===0) console.log(JSON.stringify({event:"ARCHIVE_RESTORE_PROGRESS",restored}));
    }
  }
  if(batch.length){
    const {error}=await db.from("luna_research_prices").upsert(batch,{onConflict:"dataset_id,symbol,date"});
    if(error) throw error;
    restored+=batch.length;
  }
  const {count,error}=await db.from("luna_research_prices")
    .select("id",{count:"exact",head:true}).eq("dataset_id",archive.dataset_id);
  if(error) throw error;
  if((count??0)<Number(manifest.row_count)) throw new Error(`RESTORE_ROW_COUNT_SHORTFALL:${count}/${manifest.row_count}`);
  const {error:updateError}=await db.from("luna_research_archives").update({
    status:"RESTORE_VERIFIED",restore_verified_at:new Date().toISOString(),
    metadata:{...(archive.metadata??{}),restore_verified:true,restored_rows:restored,post_restore_dataset_rows:count}
  }).eq("id",archive.id);
  if(updateError) throw updateError;
  console.log(JSON.stringify({event:"ARCHIVE_RESTORE_VERIFIED",archive_id:archive.id,restored_rows:restored,dataset_rows:count}));
}
main().catch(error=>{
  console.error(JSON.stringify({event:"ARCHIVE_RESTORE_FAILED",error:error instanceof Error?error.message:String(error)}));
  process.exitCode=1;
});
