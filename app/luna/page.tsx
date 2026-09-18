export default function LunaPage(){
  const rules=[
    ["Initial capital","฿1,000,000"],
    ["Max / symbol","20%"],
    ["Max gross exposure","100%"],
    ["Mode","PAPER"],
    ["Live feed","NOT CONNECTED"],
    ["End-of-day","FORCE CLOSE"],
  ];
  return <main style={{minHeight:"100vh",background:"#07110d",color:"#ecfdf5",padding:"40px",fontFamily:"Inter,Arial,sans-serif"}}>
    <div style={{maxWidth:1200,margin:"0 auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"end",marginBottom:32}}>
        <div><div style={{fontSize:12,letterSpacing:3,color:"#86efac"}}>LUNA-TH1H</div><h1 style={{fontSize:42,margin:"8px 0"}}>Intraday Control Room</h1><p style={{color:"#a7f3d0"}}>Auditable SET/mai paper-trading infrastructure</p></div>
        <div style={{padding:"8px 14px",border:"1px solid #166534",borderRadius:999,color:"#86efac"}}>PAPER / SAFE</div>
      </div>
      <section style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
        {rules.map(([a,b])=><div key={a} style={{background:"#0b1b14",border:"1px solid #163c2b",borderRadius:16,padding:20}}><div style={{fontSize:12,color:"#86efac"}}>{a}</div><div style={{fontSize:25,fontWeight:700,marginTop:8}}>{b}</div></div>)}
      </section>
      <section style={{marginTop:24,background:"#0b1b14",border:"1px solid #163c2b",borderRadius:16,padding:24}}>
        <h2 style={{marginTop:0}}>System status</h2>
        <div style={{display:"grid",gap:12}}>
          <div>Railway worker <b style={{color:"#86efac"}}>BOOTSTRAPPED</b></div>
          <div>Supabase schema <b style={{color:"#86efac"}}>READY</b></div>
          <div>Market-data adapter <b style={{color:"#fbbf24"}}>MOCK ONLY</b></div>
          <div>Execution <b style={{color:"#86efac"}}>SIMULATED ONLY</b></div>
        </div>
      </section>
      <section style={{marginTop:24,background:"#0b1b14",border:"1px solid #163c2b",borderRadius:16,padding:24}}>
        <h2 style={{marginTop:0}}>Audit pipeline</h2>
        <p style={{color:"#a7f3d0"}}>Market ticks → validation → strategy signal → risk gate → simulated fill → portfolio snapshot → immutable audit event.</p>
      </section>
    </div>
  </main>
}