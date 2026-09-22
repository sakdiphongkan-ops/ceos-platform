export function monthlyStats(curve:any[],initial:number){
  const months=new Map<string,{last:number;ts:number}>();
  for(const p of curve){
    const d=new Date(p.ts);
    const parts=new Intl.DateTimeFormat("en-CA",{
      timeZone:"Asia/Bangkok",year:"numeric",month:"2-digit"
    }).formatToParts(d);
    const year=parts.find(x=>x.type==="year")?.value;
    const month=parts.find(x=>x.type==="month")?.value;
    const key=`${year}-${month}`;
    const ts=d.getTime();
    const x=months.get(key);
    if(!x || ts>x.ts) months.set(key,{last:Number(p.equity),ts});
  }
  const ordered=[...months.entries()]
    .sort((x,y)=>x[0].localeCompare(y[0]))
    .map(([,x])=>x.last);
  if(!ordered.length) return {geo:0,positiveRatio:0,returns:[] as number[]};
  const returns:number[]=[];
  let previous=initial;
  for(const monthEnd of ordered){
    returns.push(previous>0?monthEnd/previous-1:0);
    previous=monthEnd;
  }
  let logSum=0;
  for(const r of returns) logSum+=Math.log(Math.max(1e-9,1+r));
  return {
    geo:Math.exp(logSum/returns.length)-1,
    positiveRatio:returns.filter(r=>r>0).length/returns.length,
    returns
  };
}
