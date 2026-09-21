export type ExecutionScheduleResult = {
  executed:boolean;
  superseded:boolean;
};

type PendingJob = {
  task:()=>Promise<void>;
  resolve:(result:ExecutionScheduleResult)=>void;
  reject:(error:unknown)=>void;
};

type Mailbox = {
  running:boolean;
  pending?:PendingJob;
};

export type ExecutionSchedulerStats = {
  activeJobs:number;
  queuedSymbols:number;
  pendingJobs:number;
};

export class LatestExecutionScheduler{
  private readonly maxConcurrency:number;
  private activeJobs=0;
  private readonly readySymbols:string[]=[];
  private readonly scheduled=new Set<string>();
  private readonly mailboxes=new Map<string,Mailbox>();

  constructor(maxConcurrency:number){
    if(!Number.isInteger(maxConcurrency) || maxConcurrency<1){
      throw new Error("EXECUTION_SCHEDULER_CONCURRENCY_MUST_BE_POSITIVE_INTEGER");
    }
    this.maxConcurrency=maxConcurrency;
  }

  enqueue(symbol:string,task:()=>Promise<void>):Promise<ExecutionScheduleResult>{
    let mailbox=this.mailboxes.get(symbol);
    if(!mailbox){
      mailbox={running:false};
      this.mailboxes.set(symbol,mailbox);
    }

    if(mailbox.pending){
      mailbox.pending.resolve({executed:false,superseded:true});
    }

    const promise=new Promise<ExecutionScheduleResult>((resolve,reject)=>{
      mailbox!.pending={task,resolve,reject};
    });

    this.schedule(symbol);
    this.pump();
    return promise;
  }

  stats():ExecutionSchedulerStats{
    let pendingJobs=0;
    for(const mailbox of this.mailboxes.values()){
      if(mailbox.pending) pendingJobs++;
    }
    return {
      activeJobs:this.activeJobs,
      queuedSymbols:this.readySymbols.length,
      pendingJobs
    };
  }

  private schedule(symbol:string){
    const mailbox=this.mailboxes.get(symbol);
    if(!mailbox || mailbox.running || !mailbox.pending || this.scheduled.has(symbol)) return;
    this.scheduled.add(symbol);
    this.readySymbols.push(symbol);
  }

  private pump(){
    while(this.activeJobs<this.maxConcurrency && this.readySymbols.length>0){
      const symbol=this.readySymbols.shift()!;
      this.scheduled.delete(symbol);
      const mailbox=this.mailboxes.get(symbol);
      if(!mailbox || mailbox.running || !mailbox.pending) continue;

      const job=mailbox.pending;
      mailbox.pending=undefined;
      mailbox.running=true;
      this.activeJobs++;

      void job.task()
        .then(()=>{
          job.resolve({executed:true,superseded:false});
        },(error)=>{
          job.reject(error);
        })
        .finally(()=>{
          mailbox.running=false;
          this.activeJobs--;
          if(mailbox.pending){
            this.schedule(symbol);
          }else{
            this.mailboxes.delete(symbol);
          }
          this.pump();
        })
        .catch(()=>undefined);
    }
  }
}
