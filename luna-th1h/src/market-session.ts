export type MarketPhase = "CLOSED"|"ACTIVE"|"REDUCE_ONLY"|"FORCE_CLOSE";

function localMinutes(ts:string,timezone:string){
  const parts=new Intl.DateTimeFormat("en-GB",{
    timeZone:timezone,
    hour:"2-digit",
    minute:"2-digit",
    hourCycle:"h23"
  }).formatToParts(new Date(ts));
  const hour=Number(parts.find(p=>p.type==="hour")?.value ?? 0);
  const minute=Number(parts.find(p=>p.type==="minute")?.value ?? 0);
  return hour*60+minute;
}

function hhmmMinutes(value:string){
  const [h,m]=value.split(":").map(Number);
  if(!Number.isInteger(h)||!Number.isInteger(m)||h<0||h>23||m<0||m>59){
    throw new Error(`INVALID_HHMM: ${value}`);
  }
  return h*60+m;
}

export function marketPhaseAt(
  ts:string,
  timezone="Asia/Bangkok",
  reduceOnlyTime="16:20",
  forceCloseTime="16:25"
):MarketPhase{
  const minutes=localMinutes(ts,timezone);
  const weekday=new Intl.DateTimeFormat("en-US",{
    timeZone:timezone,
    weekday:"short"
  }).format(new Date(ts));

  if(weekday==="Sat" || weekday==="Sun") return "CLOSED";

  const morningStart=10*60;
  const morningEnd=12*60+30;
  const afternoonStart=14*60;
  const tradingEnd=16*60+30;
  const reduceOnly=hhmmMinutes(reduceOnlyTime);
  const forceClose=hhmmMinutes(forceCloseTime);

  if(forceClose<=reduceOnly) throw new Error("forceCloseTime must be after reduceOnlyTime");
  if(minutes<morningStart) return "CLOSED";
  if(minutes>=morningEnd && minutes<afternoonStart) return "CLOSED";
  if(minutes>=tradingEnd) return "CLOSED";
  if(minutes>=forceClose) return "FORCE_CLOSE";
  if(minutes>=reduceOnly) return "REDUCE_ONLY";
  return "ACTIVE";
}

export function sessionDateAt(ts:string,timezone="Asia/Bangkok"){
  return new Intl.DateTimeFormat("en-CA",{
    timeZone:timezone,
    year:"numeric",
    month:"2-digit",
    day:"2-digit"
  }).format(new Date(ts));
}
