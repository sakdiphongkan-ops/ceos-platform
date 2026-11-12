import {createClient} from "@supabase/supabase-js";
import {S3Client,GetObjectCommand} from "@aws-sdk/client-s3";
import {createHash} from "node:crypto";
import {Readable} from "node:stream";
import {createGunzip} from "node:zlib";

const objectKey=process.env.LUNA_ARCHIVE_OBJECT_KEY??"";
const supabaseUrl=process.env.SUPABASE_URL??"";
const serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY??"";
const accountId=process.env.R2_ACCOUNT_ID??"";
const accessKeyId=process.env.R2_ACCESS_KEY_ID??"";
const secretAccessKey=process.env.R2_SECRET_ACCESS_KEY??"";
const bucket=process.env.R2_BUCKET_NAME??"";
if(!objectKey||!supabaseUrl||!serviceRoleKey||!accountId||!accessKeyId||!secretAccessKey||!bucket){
  throw new Error("Archive object key, Supabase service credentials and R2 credentials are required");
}
const db=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const s3=new S3Client({region:"auto",endpoint:`https://${accountId}.r2.cloudflarestorage.com`,forcePathStyle:true,credentials:{accessKeyId,secretAccessKey}});

async function main(){
  const {data:archive,error}=await db.from("luna_research_archives").select("*").eq("object_key",objectKey).single();
  if(error) throw error;
  const manifestObject=await s3.send(new GetObjectCommand({Bucket:bucket,Key:archive.manifest_key}));
  if(!manifestObject.Body) throw new Error("ARCHIVE_MANIFEST_BODY_MISSING");
  const manifestText=await manifestObject.Body.transformToString();
  const manifest=JSON.parse(manifestText) as {dataset_id:string;row_count:number;source_sha256_uncompressed_ndjson:string;object_key:string};
  if(manifest.object_key!==objectKey||manifest.dataset_id!==archive.dataset_id) throw new Error("ARCHIVE_MANIFEST_IDENTITY_MISMATCH");

  const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:objectKey}));
  if(!object.Body) throw new Error("ARCHIVE_OBJECT_BODY_MISSING");
  const gunzip=(object.Body as Readable).pipe(createGunzip());
  const hash=createHash("sha256");
  let rowCount=0;
  let lastByte=10;
  for await(const part of gunzip){
    const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
    hash.update(chunk);
    for(const byte of chunk) if(byte===10) rowCount++;
    if(chunk.length) lastByte=chunk[chunk.length-1];
  }
  if(lastByte!==10) throw new Error("ARCHIVE_NDJSON_MISSING_FINAL_NEWLINE");
  const actualHash=hash.digest("hex");
  if(rowCount!==Number(manifest.row_count)||rowCount!==Number(archive.row_count)) {
    throw new Error(`ARCHIVE_READBACK_ROW_COUNT_MISMATCH:${rowCount}`);
  }
  if(actualHash!==manifest.source_sha256_uncompressed_ndjson||actualHash!==archive.source_sha256){
    throw new Error("ARCHIVE_READBACK_SHA256_MISMATCH");
  }
  const {error:updateError}=await db.from("luna_research_archives").update({
    status:"VERIFIED",verified_at:new Date().toISOString(),
    metadata:{...(archive.metadata??{}),readback_verified:true,readback_row_count:rowCount,readback_sha256:actualHash}
  }).eq("id",archive.id);
  if(updateError) throw updateError;
  console.log(JSON.stringify({event:"ARCHIVE_READBACK_VERIFIED",archive_id:archive.id,object_key:objectKey,row_count:rowCount,sha256:actualHash}));
}
main().catch(error=>{
  console.error(JSON.stringify({event:"ARCHIVE_READBACK_FAILED",error:error instanceof Error?error.message:String(error)}));
  process.exitCode=1;
});
