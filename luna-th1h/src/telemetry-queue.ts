export type TelemetryTick = {
  action:"tick";
  session_id:string;
  quote:Record<string,unknown>;
};

export type TelemetrySignal = {
  action:"signal";
  session_id:string;
  signal:Record<string,unknown>;
};

export type TelemetryItem = TelemetryTick|TelemetrySignal;

export type TelemetryBatchFlush = (items:TelemetryItem[])=>Promise<unknown>;

export type TelemetryQueueOptions = {
  maxBatchSize?:number;
  flushMs?:number;
  maxPendingSignals?:10000;
};

export class TelemetryQueue{
  private readonly maxBatchSize:number;
  private readonly flushMs:number;
  private readonly maxPendingSignals:number;
  private readonly pendingSignals:TelemetrySignal[]=[];
  private readonly pendingTicks=new Map<string,TelemetryTick>();
  private timer:NodeJS.Timeout|undefined;
  private flushing=false;
  private readonly flushFn:TelemetryBatchFlush;

  constructor(flushFn:TelemetryBatchFlush,options:TelemetryQueueOptions={}){
    this.flushFn=flushFn;
    this.maxBatchSize=Math.max(1,Math.floor(options.maxBatchSize??50));
    this.flushMs=Math.max(5,Math.floor(options.flushMs??50));
    this.maxPendingSignals=Math.max(1,Math.floor(options.maxPendingSignals??10_000));
  }

  enqueueTick(item:TelemetryTick){
    const key=`${item.session_id}:${String(item.quote.symbol??"")}`;
    this.pendingTicks.set(key,item);
    this.schedule();
  }

  enqueueSignal(item:TelemetrySignal){
    if(this.pendingSignals.length>=this.maxPendingSignals){
      throw new Error("TELEMETRY_SIGNAL_QUEUE_FULL");
    }
    this.pendingSignals.push(item);
    this.schedule();
  }

  stats(){
    return {
      pending_signals:this.pendingSignals.length,
      pending_ticks:this.pendingTicks.size,
      flushing:this.flushing
    };
  }

  async flushAll(){
    while(this.pendingSignals.length>0 || this.pendingTicks.size>0 || this.flushing){
      await this.flush();
      if(this.pendingSignals.length>0 || this.pendingTicks.size>0 || this.flushing){
        await new Promise<void>(resolve=>setTimeout(resolve,this.flushMs));
      }
    }
  }

  private schedule(){
    if(this.timer || this.flushing) return;
    this.timer=setTimeout(()=>{
      this.timer=undefined;
      void this.flush().catch(error=>{
        console.error(JSON.stringify({
          event:"TELEMETRY_FLUSH_ERROR",
          error:String(error),
          ...this.stats()
        }));
        this.schedule();
      });
    },this.flushMs);
  }

  private drainBatch():TelemetryItem[]{
    const batch:TelemetryItem[]=[];
    while(batch.length<this.maxBatchSize && this.pendingSignals.length>0){
      batch.push(this.pendingSignals.shift()!);
    }
    if(batch.length<this.maxBatchSize){
      for(const [key,item] of this.pendingTicks){
        batch.push(item);
        this.pendingTicks.delete(key);
        if(batch.length>=this.maxBatchSize) break;
      }
    }
    return batch;
  }

  private async flush(){
    if(this.flushing) return;
    if(this.pendingSignals.length===0 && this.pendingTicks.size===0) return;
    this.flushing=true;
    try{
      const batch=this.drainBatch();
      if(!batch.length) return;
      try{
        await this.flushFn(batch);
      }catch(error){
        for(let i=batch.length-1;i>=0;i--){
          const item=batch[i];
          if(item.action==="signal"){
            this.pendingSignals.unshift(item);
          }else{
            const key=`${item.session_id}:${String(item.quote.symbol??"")}`;
            this.pendingTicks.set(key,item);
          }
        }
        throw error;
      }
    }finally{
      this.flushing=false;
      if(this.pendingSignals.length>0 || this.pendingTicks.size>0) this.schedule();
    }
  }
}
