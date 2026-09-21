export type BrokerOrderStatus =
  | "CREATED"
  | "SUBMITTED"
  | "ACKNOWLEDGED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "UNKNOWN";

export interface BrokerOrderState {
  clientOrderId:string;
  brokerOrderId:string|null;
  symbol:string;
  side:"BUY"|"SELL";
  submittedQty:number;
  filledQty:number;
  avgFillPrice:number|null;
  status:BrokerOrderStatus;
  updatedAtMs:number;
}

const transitions:Record<BrokerOrderStatus,Set<BrokerOrderStatus>>={
  CREATED:new Set(["SUBMITTED","UNKNOWN","REJECTED"]),
  SUBMITTED:new Set(["ACKNOWLEDGED","PARTIALLY_FILLED","FILLED","CANCELED","REJECTED","UNKNOWN"]),
  ACKNOWLEDGED:new Set(["PARTIALLY_FILLED","FILLED","CANCELED","REJECTED","UNKNOWN"]),
  PARTIALLY_FILLED:new Set(["PARTIALLY_FILLED","FILLED","CANCELED","REJECTED","UNKNOWN"]),
  FILLED:new Set(["FILLED"]),
  CANCELED:new Set(["CANCELED"]),
  REJECTED:new Set(["REJECTED"]),
  UNKNOWN:new Set(["ACKNOWLEDGED","PARTIALLY_FILLED","FILLED","CANCELED","REJECTED","UNKNOWN"])
};

export function transitionBrokerOrder(
  current:BrokerOrderState,
  patch:Partial<BrokerOrderState> & {status:BrokerOrderStatus}
):BrokerOrderState{
  const nextStatus=patch.status;
  if(current.status!==nextStatus && !transitions[current.status].has(nextStatus)){
    throw new Error("INVALID_BROKER_ORDER_TRANSITION:"+current.status+"->"+nextStatus);
  }
  const filledQty=Math.max(current.filledQty,Number(patch.filledQty??current.filledQty));
  if(filledQty>current.submittedQty+1e-8){
    throw new Error("BROKER_FILLED_QTY_EXCEEDS_SUBMITTED_QTY");
  }
  if(nextStatus==="FILLED" && filledQty+1e-8<current.submittedQty){
    throw new Error("BROKER_FILLED_STATUS_WITH_INCOMPLETE_QUANTITY");
  }
  return {
    ...current,
    ...patch,
    filledQty,
    updatedAtMs:Number(patch.updatedAtMs??Date.now())
  };
}