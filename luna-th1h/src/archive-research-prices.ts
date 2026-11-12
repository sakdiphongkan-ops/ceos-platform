import {createClient} from "@supabase/supabase-js";
import {S3Client,HeadObjectCommand,PutObjectCommand} from "@aws-sdk/client-s3";
import {Upload} from "@aws-sdk/lib-storage";
import {createHash,randomUUID} from "node:crypto";
import {PassThrough,Transform} from "node:stream";
import {once} from "node:events";
import {createGzip} from "node:zlib";

const datasetId=process.env.LUNA_ARCHIVE_DATASET_ID??"1af83c59-a56f-461f-b03e-f3d04e67e384";
const supabaseUrl=process.env.SUPABASE_URL??"";
const serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY??"";
const accountId=process.env.R2_ACCOUNT_ID??"";
const accessKeyId=process.env.R2_ACCESS_KEY_ID??"";
const secretAccessKey=process.env.R2_SECRET_ACCESS_KEY??"";
const bucket=process.env.R2_BUCKET_NAME??"";
const prefix=(process.env.R2_ARCHIVE_PREFIX??"luna/research-prices").replace(/^\/+|\/+$/g,"");
const chunkSize=Math.max(100,Math.min(10000,Number(process.env.LUNA_ARCHIVE_CHUNK_SIZE??5000)));
if(!supabaseUrl||!serviceRoleKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
if(!accountId||!accessKeyId||!secretAccessKey||!bucket) throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET_NAME are required");
if(!Number.isInteger(chunkSize)) throw new Error("LUNA_ARCHIVE_CHUNK_SIZE must be an integer");

const db=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const s3=new S3Client({
  region:"auto",
  endpoint:`https://${accountId}.r2.cloudflarestorage.com`,
  forcePathStyle:true,
  credentials:{accessKeyId,secretAccessKey}
});

async function writeWithBackpressure(stream:Transform,chunk:string){
  if(!stream.write(chunk)) await once(stream,"drain");
}
async function main(){
  const {data:dataset,error:datasetError}=await db.from("luna_research_datasets")
    .select("id,name,source,start_date,end_date,symbol_count,row_count,checksum_sha256,metadata")
    .eq("id",datasetId).single();
  if(datasetError) throw datasetError;
  const expectedRows=Number(dataset.row_count??0);
  if(expectedRows<=0) throw new Error("DATASET_ROW_COUNT_MISSING_OR_ZERO");

  const runId=randomUUID();
  const key=`${prefix}/${datasetId}/${runId}.ndjson.gz`;
  const manifestKey=`${prefix}/${datasetId}/${runId}.manifest.json`;
  const rawHash=createHash("sha256");
  const body=new PassThrough({highWaterMark:1024*1024});
  const gzip=createGzip({level:9});
  const hashStream=new Transform({
    transform(chunk,encoding,callback){rawHash.update(chunk);callback(null,chunk);}
  });
  hashStream.pipe(gzip).pipe(body);

  const upload=new Upload({
    client:s3,
    params:{
      Bucket:bucket,Key:key,Body:body,
      ContentType:"application/x-ndjson",
      ContentEncoding:"gzip",
      Metadata:{datasetid:datasetId,format:"ndjson",compression:"gzip",runid:runId}
    },
    queueSize:2,
    partSize:8*1024*1024,
    leavePartsOnError:false
  });
  const uploadPromise=upload.done();
  let cursorSymbol:string|null=null;
  let cursorDate:string|null=null;
  let rowsWritten=0;
  let chunks=0;
  let done=false;

  try{
    while(!done){
      const {data,error}=await db.rpc("luna_export_research_prices_chunk",{
        p_dataset_id:datasetId,
        p_after_symbol:cursorSymbol,
        p_after_date:cursorDate,
        p_limit:chunkSize
      });
      if(error) throw error;
      const result=data as {rows?:Record<string,unknown>[];row_count?:number;next_symbol?:string|null;next_date?:string|null;done?:boolean};
      const rows=result.rows??[];
      if(rows.length!==Number(result.row_count??0)) throw new Error("ARCHIVE_CHUNK_ROW_COUNT_MISMATCH");
      if(rows.length===0 && !result.done) throw new Error("ARCHIVE_CURSOR_STALLED");
      for(const row of rows){
        await writeWithBackpressure(hashStream,JSON.stringify(row)+"\n");
        rowsWritten++;
      }
      chunks++;
      if(rows.length>0){
        cursorSymbol=String(result.next_symbol);
        cursorDate=String(result.next_date);
      }
      done=Boolean(result.done);
      if(chunks%20===0) console.log(JSON.stringify({event:"ARCHIVE_PROGRESS",dataset_id:datasetId,chunks,rows_written:rowsWritten}));
    }
    if(rowsWritten!==expectedRows){
      throw new Error(`ARCHIVE_ROW_COUNT_MISMATCH:expected=${expectedRows}:actual=${rowsWritten}`);
    }
    hashStream.end();
    await uploadPromise;
    const sourceSha256=rawHash.digest("hex");
    const head=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}));
    if(!head.ContentLength || head.ContentLength<=0) throw new Error("ARCHIVE_OBJECT_EMPTY_AFTER_UPLOAD");
    const manifest={
      format:"LUNA_RESEARCH_PRICES_ARCHIVE_V1",
      dataset_id:datasetId,dataset_name:dataset.name,source:dataset.source,
      row_count:rowsWritten,expected_row_count:expectedRows,
      symbol_count:Number(dataset.symbol_count??0),
      start_date:dataset.start_date,end_date:dataset.end_date,
      source_sha256_uncompressed_ndjson:sourceSha256,
      object_key:key,object_size_bytes:head.ContentLength,
      content_encoding:"gzip",content_type:"application/x-ndjson",
      chunks,chunk_size:chunkSize,run_id:runId,
      archived_at:new Date().toISOString(),
      deletion_performed:false,
      note:"Source rows remain untouched until an independent restore and checksum verification is approved."
    };
    await s3.send(new PutObjectCommand({
      Bucket:bucket,Key:manifestKey,Body:JSON.stringify(manifest,null,2),
      ContentType:"application/json",
      Metadata:{datasetid:datasetId,sourcehash:sourceSha256,runid:runId}
    }));
    const manifestHead=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:manifestKey}));
    if(!manifestHead.ContentLength) throw new Error("ARCHIVE_MANIFEST_NOT_VERIFIED");
    const {error:registryError}=await db.from("luna_research_archives").insert({
      dataset_id:datasetId,object_key:key,manifest_key:manifestKey,
      source_sha256:sourceSha256,row_count:rowsWritten,
      object_size_bytes:head.ContentLength,status:"UPLOADED",
      metadata:{run_id:runId,format:"ndjson",compression:"gzip",chunks,chunk_size:chunkSize}
    });
    if(registryError) throw registryError;
    console.log(JSON.stringify({event:"ARCHIVE_UPLOADED_PENDING_READBACK_VERIFICATION",manifest}));
  }catch(error){
    hashStream.destroy(error instanceof Error?error:new Error(String(error)));
    body.destroy(error instanceof Error?error:new Error(String(error)));
    await upload.abort().catch(()=>undefined);
    await uploadPromise.catch(()=>undefined);
    throw error;
  }
}
main().catch(error=>{
  console.error(JSON.stringify({event:"ARCHIVE_FAILED",error:error instanceof Error?error.message:String(error)}));
  process.exitCode=1;
});
