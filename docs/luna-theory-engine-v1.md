# LUNA Theory Engine v1

## 1. เปลี่ยนโจทย์หลัก

LUNA จะไม่ใช้ "search the best formula" เป็นแกนหลักอีกต่อไป

โจทย์ใหม่คือ:

> ค้นหากลไก (mechanisms) ที่ทำให้หุ้นบางกลุ่มมีผลตอบแทนคาดหมายแตกต่างกัน แล้วสกัดกลไกเหล่านั้นจากสูตรจำนวนมาก ก่อนสร้างสูตรของ LUNA เอง

การค้นหาสูตรจำนวนมากยังคงใช้ แต่เปลี่ยนจาก "ผู้ชนะ" เป็น "หลักฐานสำหรับการเรียนรู้"

## 2. สิ่งที่ LUNA ต้องเรียนรู้จากสูตรทุกชุด

ทุกสูตรจะถูกแปลงเป็น Formula Genome:

- factor family: momentum / reversal / liquidity / volatility / quality / value / growth / risk / market regime
- horizon: 1M / 3M / 6M / 12M ฯลฯ
- direction: HIGH / LOW
- threshold: top/bottom quantile
- weight structure
- interaction type: additive / AND / OR / nonlinear
- holding period
- rebalance frequency
- universe constraint
- liquidity constraint
- risk overlay
- transaction-cost sensitivity
- regime dependency

จากนั้นสร้าง similarity graph และ cluster สูตรตาม "กลไก" ไม่ใช่แค่ชื่อสูตร

## 3. Council ของ LUNA

### CIO / Portfolio Manager
กำหนด objective, capital allocation, diversification และความสอดคล้องกับข้อจำกัดจริง

### Quant Researcher
ตั้งสมมติฐานเกี่ยวกับ cross-sectional return และ factor interaction

### Financial Engineer
ออกแบบ transformation, weighting, nonlinear interaction และ portfolio construction

### Economist / Macro Researcher
ตรวจว่าผลลัพธ์อธิบายได้ด้วย business cycle, liquidity, rates, risk appetite หรือ market regime หรือไม่

### Statistician
ตรวจ multiple testing, data snooping, dependence, confidence intervals, bootstrap และ false discovery

### Machine Learning Scientist
ค้นหา nonlinear interaction และ conditional structure โดยต้องรักษา time-series leakage guard

### Data / Accounting Auditor
ตรวจ point-in-time data, survivorship bias, corporate actions, missing data และ universe drift

### Risk Manager
ตรวจ drawdown, tail loss, concentration, turnover, liquidity และ stress scenarios

### Execution / Market Microstructure Researcher
ตรวจ spread, slippage, market impact, trading frequency และ integer-share feasibility

### Skeptical Peer Reviewer
พยายามทำลาย hypothesis ทุกตัว โดยถามว่า:
"หลักฐานนี้เป็นเหตุผลจริง หรือเป็นเพียง pattern ที่บังเอิญเกิดขึ้นใน sample?"

ไม่มี role ใดมีสิทธิ์ประกาศ "สูตรสุดยอด" คนเดียว

## 4. Research loop ใหม่

### Stage A — Formula Archaeology
รวบรวมสูตรทั้งหมดที่ LUNA เคยทดสอบ รวม legacy M1, tournament, horizon tests, regime tests และสูตรจาก literature

### Stage B — Formula Genome
แปลงสูตรทั้งหมดเป็น representation เดียวกัน และสร้าง similarity / cluster map

### Stage C — Factor Contribution
วัด:
- marginal contribution
- conditional contribution
- interaction contribution
- redundancy
- regime dependence
- cost sensitivity

### Stage D — Mechanism Discovery
ถามเชิงกลไก เช่น:

"สูตรที่ดีมี common structure อะไร แม้ parameter จะต่างกัน?"

"reversal ดีเพราะ short-term mean reversion จริง หรือเพราะมี liquidity/volatility filter?"

"52-week-high signal เพิ่มข้อมูลใหม่หรือเพียง duplicate momentum?"

"liquidity ช่วยผลตอบแทนหรือเพียงลด implementation drag?"

### Stage E — Theory Generation
สร้างทฤษฎี candidate ของ LUNA จาก common mechanisms

ตัวอย่าง grammar:

ExpectedReturn = CoreSignal + ConditionalInteraction + RegimeAdjustment - RiskPenalty - CostPenalty

### Stage F — Controlled Formula Generation
จากทฤษฎีหนึ่งชุด สร้างเฉพาะสูตรที่อยู่ใน hypothesis family เดียวกัน แทนการสุ่มสูตรอย่างอิสระ

### Stage G — Nested Validation
ใช้:
1. development
2. validation
3. OOS walk-forward
4. frozen holdout
5. fresh-period replication

ห้ามใช้ holdout เพื่อออกแบบสูตร

### Stage H — Adversarial Testing
ทดสอบ:
- 0 / 10 / 20 / 30 / 45 / 60 bps
- different K
- different rebalance anchors
- integer shares
- liquidity floor
- universe variants
- bull / bear / sideways
- high / low volatility
- different starting capital
- different seeds
- leave-one-period-out

### Stage I — Promotion
สูตรจะเลื่อนระดับเมื่อ "กลไก" และ "ผลลัพธ์" ผ่านพร้อมกัน

ไม่ใช่เพราะ backtest return สูงที่สุด

## 5. 7% ต่อเดือน

7% geometric monthly เท่ากับประมาณ 125% geometric annual return

ดังนั้น LUNA จะเก็บ 7%/เดือนเป็น **Gold Target** แต่จะไม่ใช้เป็นเกณฑ์เดียวในการตัดสิน เพราะการไล่ให้ถึงตัวเลขสูงมากด้วยการทดลองจำนวนมากเพิ่มแรงจูงใจให้ระบบ overfit

ลำดับหลักในการตัดสิน:

1. กลไกมีเหตุผล
2. ผลลัพธ์ OOS
3. ผลลัพธ์ frozen holdout
4. ความเสถียรข้าม regime
5. cost robustness
6. drawdown / tail risk
7. replication
8. geometric return

ถ้าสูตรได้ 7%/เดือนใน sample แต่กลไกไม่เสถียร ให้ถือว่าเป็น hypothesis ไม่ใช่ breakthrough

## 6. สิ่งที่เรารู้แล้วจาก LUNA

จากฐาน tournament ที่มีอยู่ พบว่ามีบาง formula family ที่อยู่รอดเมื่อดูทั้ง TEST และ RECENT_OOS และภายใต้ transaction-cost stress แต่ไม่มี candidate ใน persisted 130-variant set ที่ผ่าน Gold Target 7% geometric/month ในทั้ง TEST และ RECENT_OOS ที่ 20 bps

ข้อสรุปที่ถูกต้องคือ:

> "เรายังหาไม่พบ" ไม่ใช่ "ไม่มีอยู่จริง"

ดังนั้นขั้นต่อไปไม่ควรเป็นการเพิ่มจำนวน random formulas อย่างเดียว แต่ควรเพิ่ม information gained per experiment

## 7. Output ที่ต้องมีทุก research round

ทุก round ของ LUNA ต้องสร้าง:

- Formula Genome
- Mechanism clusters
- Common factors
- Contradictory factors
- Interaction candidates
- Failed hypotheses
- Surviving hypotheses
- New theory
- New formula family
- OOS results
- Holdout results
- Cost stress
- Risk stress
- Multiple-testing diagnostics
- Researcher notes / explanation

## 8. กฎเหล็ก

- ห้ามเลือกสูตรจาก holdout
- ห้ามใช้อนาคตในการสร้าง factor
- ห้ามเปลี่ยน universe หลังเห็นผลแล้วโดยไม่เปิดเผย
- ห้ามนับสูตรที่คล้ายกันมากเป็น independent evidence
- ห้ามใช้ top historical return เป็นหลักฐานเพียงอย่างเดียว
- ห้ามลบสูตรที่ fail เพราะเป็น "negative evidence"
- ต้องเก็บทุก experiment แบบ reproducible
- ต้องบันทึกเหตุผลที่สร้างสูตรใหม่ทุกสูตร
- ต้องมี benchmark M1 เดิมอยู่ทุกครั้ง
- ต้องแยก "discovery" ออกจาก "confirmation"

## 9. เป้าหมายสุดท้าย

LUNA ไม่ควรจบที่:

> "สูตร F123 ชนะ"

LUNA ควรจบที่:

> "จากการศึกษาสูตรหลายพัน/หลายล้านแบบ เราพบกลไก A+B+C ที่ยังคงปรากฏในหลาย independent families, ทำงานในหลาย regimes, ทน transaction costs, และยังคงปรากฏในข้อมูลใหม่ที่ไม่เคยใช้สร้างสมมติฐาน"

จากนั้นจึงสร้าง:

**LUNA Native Theory → LUNA Native Formula → LUNA Production Strategy**
