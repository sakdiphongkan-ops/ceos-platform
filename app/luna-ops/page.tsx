import Link from "next/link";

const agents = [
  { name: "Market Intelligence", role: "ตรวจสอบข้อมูลตลาด", state: "NOT CONNECTED" },
  { name: "Quant Research", role: "สร้างและทดสอบสมมติฐาน", state: "NOT CONNECTED" },
  { name: "Independent Validator", role: "ตรวจ OOS / HOLDOUT", state: "NOT CONNECTED" },
  { name: "Risk Controller", role: "ตรวจความเสี่ยงก่อนส่งคำสั่ง", state: "POLICY ONLY" },
  { name: "Paper Execution", role: "จำลองคำสั่งและกระทบยอด", state: "LOCKED" },
];

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="metric"><span className="eyebrow">{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

export default function LunaOpsPage() {
  return (
    <main className="ops-shell">
      <style>{`
        .ops-shell{min-height:100vh;background:#f4f6f7;color:#172b2a;padding:28px; font-family:Arial,'Noto Sans Thai',sans-serif}
        .ops-wrap{max-width:1440px;margin:0 auto}.ops-top{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:26px}
        .brand{display:flex;gap:12px;align-items:center}.brand-mark{display:grid;place-items:center;width:44px;height:44px;border-radius:14px;background:#173f3a;color:#fff;font-weight:800;letter-spacing:-1px}
        .brand h1{font-size:23px;margin:0;font-weight:750;letter-spacing:-.5px}.brand p,.muted{color:#647573;font-size:13px;margin:5px 0 0}
        .top-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.pill{border:1px solid #d7e0dd;border-radius:999px;padding:8px 12px;font-size:12px;background:#fff;color:#465c58}
        .pill.warn{background:#fff8e9;border-color:#efd8a8;color:#875d17}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;padding:28px;border-radius:22px;background:#fff;border:1px solid #e3e9e7;margin-bottom:18px}
        .hero h2{font-size:clamp(25px,3vw,38px);line-height:1.15;margin:10px 0 8px;letter-spacing:-1px}.hero p{max-width:720px;line-height:1.65;color:#657774;margin:0}
        .section-label{font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#7b8d89;font-weight:700}.capital{min-width:210px;padding:16px 18px;border-radius:16px;background:#eef5f1}.capital strong{display:block;font-size:26px;margin:5px 0}.capital small{color:#61736d}
        .metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}.metric,.panel{background:#fff;border:1px solid #e3e9e7;border-radius:18px;padding:20px}.metric strong{display:block;font-size:25px;margin:12px 0 7px;letter-spacing:-.7px}.metric small{font-size:12px;color:#7a8986}.eyebrow{font-size:12px;color:#60736e;font-weight:650}
        .grid{display:grid;grid-template-columns:1.25fr .75fr;gap:18px;margin-bottom:18px}.panel h3{font-size:16px;margin:0 0 5px}.panel-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:18px}.empty{min-height:190px;border:1px dashed #cbd8d4;border-radius:14px;background:#f9fbfa;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:20px;color:#70817c}.empty b{color:#405b55;margin:9px 0 5px}.empty p{font-size:13px;line-height:1.6;max-width:390px;margin:0}
        .agent-list{display:flex;flex-direction:column;gap:0}.agent{display:flex;justify-content:space-between;gap:14px;padding:13px 0;border-bottom:1px solid #edf1ef}.agent:last-child{border-bottom:0}.agent b{font-size:13px;display:block}.agent small{font-size:12px;color:#778782;display:block;margin-top:4px}.state{font-size:10px;letter-spacing:.3px;white-space:nowrap;border-radius:7px;background:#f1f3f2;color:#66736f;padding:6px 8px;height:max-content}
        .bottom-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.list-empty{padding:16px;border-radius:12px;background:#f8faf9;color:#73817d;font-size:13px;line-height:1.6}
        .footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:20px 4px;color:#879590;font-size:11px}.footer a{color:#476c63;text-decoration:none}
        @media(max-width:900px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.grid,.bottom-grid{grid-template-columns:1fr}.hero{align-items:flex-start;flex-direction:column}.capital{width:100%;box-sizing:border-box}}
        @media(max-width:560px){.ops-shell{padding:14px}.ops-top{align-items:flex-start;flex-direction:column}.metrics{gap:9px}.metric{padding:14px}.metric strong{font-size:21px}.panel,.hero{padding:17px}.brand h1{font-size:20px}}
      `}</style>
      <div className="ops-wrap">
        <header className="ops-top">
          <div className="brand"><div className="brand-mark">L</div><div><h1>LUNA <span style={{fontWeight:400,color:"#6d817b"}}> / CONTROL ROOM</span></h1><p>ระบบปฏิบัติการวิจัยและ Paper Trading หุ้นไทย</p></div></div>
          <div className="top-right"><span className="pill">SET / mai</span><span className="pill warn">● PAPER ONLY · LIVE TRADING LOCKED</span></div>
        </header>
        <section className="hero">
          <div><span className="section-label">Mission Control · 01</span><h2>ตลาด ข้อมูล และการตัดสินใจ<br/>อยู่ในหน้าจอเดียว</h2><p>LUNA จะทำงานเป็นระบบตั้งแต่ตรวจสอบข้อมูล วิจัยสูตร ทดสอบอย่างอิสระ ควบคุมความเสี่ยง ไปจนถึงจำลองคำสั่งซื้อขาย ทุกขั้นตอนต้องมีหลักฐานและตรวจสอบย้อนหลังได้</p></div>
          <div className="capital"><span className="eyebrow">ทุนตั้งต้นที่กำหนดไว้</span><strong>฿30,000</strong><small>วงเงินสำหรับ Paper Trading เท่านั้น · ไม่ใช่ยอดเงินจริงที่ตรวจยืนยันแล้ว</small></div>
        </section>
        <section className="metrics">
          <Metric label="Market feed" value="—" note="NOT CONNECTED · ยังไม่มีราคาที่ตรวจยืนยัน" />
          <Metric label="Portfolio equity" value="—" note="รอข้อมูล ledger และราคาตลาดที่ตรวจสอบได้" />
          <Metric label="Realized / Unrealized P&L" value="—" note="ยังไม่คำนวณจากรายการ fill ที่ยืนยันแล้ว" />
          <Metric label="LUNA heartbeat" value="—" note="ยังไม่มี heartbeat จาก agent runtime" />
        </section>
        <section className="grid">
          <article className="panel">
            <div className="panel-head"><div><span className="section-label">Market field</span><h3 style={{marginTop:7}}>SET / mai · Watchlist · 15M</h3><p className="muted">ราคา แหล่งข้อมูล เวลาอัปเดต และสถานะความสด</p></div><span className="pill">NO VERIFIED FEED</span></div>
            <div className="empty"><span style={{fontSize:25}}>⌁</span><b>ยังไม่แสดงกราฟราคา</b><p>ระบบจะวาดกราฟเมื่อเชื่อมต่อแหล่งข้อมูลที่ตรวจสอบได้เท่านั้น เพื่อไม่ให้ข้อมูลตัวอย่างถูกเข้าใจผิดว่าเป็นราคาจริง</p></div>
          </article>
          <article className="panel">
            <div className="panel-head"><div><span className="section-label">LUNA engine</span><h3 style={{marginTop:7}}>ทีม Agent และสถานะงาน</h3><p className="muted">แยกบทบาทชัดเจน · ไม่มีการอ้างว่าทำงานอยู่หากยังไม่เชื่อมต่อ</p></div></div>
            <div className="agent-list">{agents.map((agent) => <div className="agent" key={agent.name}><div><b>{agent.name}</b><small>{agent.role}</small></div><span className="state">{agent.state}</span></div>)}</div>
          </article>
        </section>
        <section className="bottom-grid">
          <article className="panel"><div className="panel-head"><div><span className="section-label">Portfolio & execution</span><h3 style={{marginTop:7}}>สถานะหุ้นและรายการซื้อขายล่าสุด</h3></div><span className="pill">PAPER LEDGER</span></div><div className="list-empty">ยังไม่มีรายการซื้อขายที่ตรวจสอบยืนยันได้ในมุมมองนี้ ระบบจะไม่สร้างรายการ BUY/SELL หรือยอดกำไรขาดทุนขึ้นมาเอง</div></article>
          <article className="panel"><div className="panel-head"><div><span className="section-label">ERP workflow</span><h3 style={{marginTop:7}}>งานค้าง · การตรวจสอบ · Audit trail</h3></div><span className="pill">CONTROL PLANE</span></div><div className="list-empty">โครงสร้างงานกำหนดให้มีผู้รับผิดชอบหนึ่งราย, idempotency key, dependency, acceptance criteria และหลักฐานก่อนปิดงาน ขณะนี้ยังไม่ได้เชื่อมหน้าเว็บเข้ากับฐานข้อมูลงาน</div></article>
        </section>
        <footer className="footer"><span>สถานะหน้านี้: UI FOUNDATION · ยังไม่ใช่ระบบเทรดที่เชื่อมต่อสมบูรณ์</span><Link href="/luna">กลับไปยัง LUNA เดิม ↗</Link><span>Fail-closed · No fabricated data · No live orders</span></footer>
      </div>
    </main>
  );
}
