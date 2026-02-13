const $ = (id) => document.getElementById(id);

const STORAGE_KEY = "mk_trip_pricing_counts_v2";
let ticketMode = "include"; // include | exclude
const RECOMMENDED_CAP = 17; // 日方建議每團學生上限（目前巴士）

// ---------- helpers ----------
function parseMoney(v){
  const s = String(v ?? "").replace(/,/g,"").replace(/[^\d]/g,"");
  return Number(s) || 0;
}
function fmtMoney(n){
  if (!Number.isFinite(n)) return "NT$ —";
  return "NT$ " + Math.round(n).toLocaleString("zh-TW");
}
function fmtPct(p){
  if (!Number.isFinite(p)) return "—";
  return (p*100).toFixed(1) + "%";
}
function clamp(n,min,max){ return Math.max(min, Math.min(max,n)); }

function formatCommaKeepCursor(input){
  const old = input.value;
  const oldPos = input.selectionStart ?? old.length;
  const digitsLeft = old.slice(0, oldPos).replace(/[^\d]/g,'').length;

  const cleaned = old.replace(/,/g,'').replace(/[^\d]/g,'');
  const formatted = cleaned ? Number(cleaned).toLocaleString('zh-TW') : "";
  input.value = formatted;

  let pos = 0, seen = 0;
  while (pos < formatted.length && seen < digitsLeft){
    if (/\d/.test(formatted[pos])) seen++;
    pos++;
  }
  input.setSelectionRange(pos,pos);
}

function setRing(el, pct, color){
  const deg = clamp(pct,0,1) * 360;
  el.style.background = `conic-gradient(${color} 0deg ${deg}deg, rgba(0,0,0,.06) ${deg}deg 360deg)`;
}

// mini stacked cost bar (proportional)
function setMiniStack(el, parts){
  // parts: [{name, value, color}]
  const total = parts.reduce((a,p)=>a+p.value, 0) || 1;
  el.innerHTML = "";
  parts.forEach(p=>{
    const span = document.createElement("span");
    span.style.width = (p.value/total*100).toFixed(2) + "%";
    span.style.background = p.color;
    el.appendChild(span);
  });
}

function makeLineSVG(el, points){
  const w = 220, h = 60, pad = 10;
  const xs = points.map((_,i)=> pad + (i*(w-2*pad)/(points.length-1)));
  const ys = points.map(v => pad + (1-v)*(h-2*pad));
  const d = xs.map((x,i)=> `${i===0?'M':'L'} ${x.toFixed(2)} ${ys[i].toFixed(2)}`).join(" ");
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <path d="${d}" fill="none" stroke="rgba(47,184,107,.85)" stroke-width="3" stroke-linecap="round"/>
      <path d="${d} L ${w-pad} ${h-pad} L ${pad} ${h-pad} Z" fill="rgba(47,184,107,.10)"/>
    </svg>
  `;
}

// 「漂亮定價」：整百 / 尾數800 / 尾數900（永遠往上取）
function beautifyPriceUp(x, mode){
  x = Math.ceil(x);
  if (mode === "hundred"){
    return Math.ceil(x / 100) * 100;
  }
  const end = Number(mode); // 800 or 900
  const base = Math.floor(x / 1000) * 1000;
  const candidate = base + end;
  if (candidate >= x) return candidate;
  return base + 1000 + end;
}

// ---------- model ----------
function compute(){
  // people
  const targetPeople  = Math.max(1, Math.floor(Number($("targetPeople").value)||20));
  const earlyCount    = Math.max(0, Math.floor(Number($("earlyCount").value)||0));
  const studentCount  = Math.max(0, Math.floor(Number($("studentCount").value)||0));
  const desiredPeople = Math.max(1, Math.floor(Number($("desiredPeople").value)||15));
  const normalCount = Math.max(0, targetPeople - earlyCount - studentCount);

  // pricing inputs
  let normalPrice = parseMoney($("priceNormal").value);
  const earlyDiscount = parseMoney($("earlyDiscount").value);
  const studentBuffer = parseMoney($("studentBuffer").value);
  const endingMode = $("priceEnding").value;
  const targetGM = clamp((Number($("targetGM").value)||20)/100, 0, 0.95);

  // costs
  const japan = parseMoney($("costJapan").value);
  let flight  = parseMoney($("costFlight").value);
  const ins   = parseMoney($("costInsurance").value);
  const sim   = parseMoney($("costSim").value);
  const book  = parseMoney($("costBook").value);
  const bigBusExtraPer = parseMoney($("bigBusExtraPer").value);
  const extraPer = parseMoney($("costExtraPer").value);

  // ads & fixed
  const adCostPerSignup = parseMoney($("adCostPerSignup").value);
  const fixedOther = parseMoney($("fixedOther").value);
  const fixed = adCostPerSignup * targetPeople + fixedOther;

  // card fee model (COUNT-BASED)
  const deposit = 15000;
  const cardCount = Math.max(0, Math.floor(Number($("cardCount").value)||0));
  const feeRate = clamp((Number($("cardFeeRate").value)||0)/100, 0, 0.2);

  // ticket mode effect
  if (ticketMode === "exclude"){
    flight = 0;
    normalPrice = Math.max(0, normalPrice - 10000);
  }

  const baseCost = japan + flight + ins + sim + book + bigBusExtraPer + extraPer;

  // derived prices
  const earlyPrice = Math.max(0, normalPrice - earlyDiscount);
  const studentPrice = baseCost + studentBuffer;

  // average price by counts
  const total = targetPeople;
  const avgPriceBeforeFee =
    (normalPrice * normalCount + earlyPrice * earlyCount + studentPrice * studentCount) / Math.max(1, total);

  // card fee per person (count-based, only remainder)
  const remainderPer = Math.max(0, avgPriceBeforeFee - deposit);
  const totalCardFee = remainderPer * cardCount * feeRate;
  const avgCardFeePer = totalCardFee / Math.max(1, total);

  // final per-person cost includes avg card fee per person
  const costPer = baseCost + avgCardFeePer;

  // breakeven (min group size)
  let breakeven = Infinity;
  if (avgPriceBeforeFee > costPer){
    breakeven = Math.ceil(fixed / (avgPriceBeforeFee - costPer));
    breakeven = Math.max(1, breakeven);
  }

  const gmAt = (n) => {
    const revenue = avgPriceBeforeFee * n;
    const cost = costPer * n + fixed;
    return revenue > 0 ? (revenue - cost) / revenue : 0;
  };

  // suggestion for desiredPeople: compute required avg, then solve for normal price
  // avgRequired = costPer + fixed/desiredPeople
  const avgRequired = costPer + (fixed / desiredPeople);
  let suggestedNormal = Infinity;

  const denom = (normalCount + earlyCount);
  if (denom > 0){
    // avg = (normal*(normalCount+earlyCount) - earlyDiscount*earlyCount + studentPrice*studentCount) / total
    const rawNormal = (avgRequired * total + earlyDiscount * earlyCount - studentPrice * studentCount) / denom;
    suggestedNormal = beautifyPriceUp(rawNormal, endingMode);
  }

  return {
    targetPeople, earlyCount, studentCount, normalCount, desiredPeople,
    normalPrice, earlyPrice, studentPrice,
    earlyDiscount, studentBuffer,
    baseCost, avgCardFeePer, costPer,
    fixed, adCostPerSignup, fixedOther,
    avgPriceBeforeFee,
    breakeven,
    gm15: gmAt(15),
    gm17: gmAt(RECOMMENDED_CAP),
    gmTarget: gmAt(targetPeople),
    targetGM,
    suggestedNormal,
    remainderPer,
    cardCount, feeRate,
    japan, flight, ins, sim, book, bigBusExtraPer, extraPer
  };
}

// ---------- render ----------
function render(){
  const m = compute();

  // counts
  $("cntNormalTxt").textContent  = `${m.normalCount}人`;
  $("cntEarlyTxt").textContent   = `${m.earlyCount}人`;
  $("cntStudentTxt").textContent = `${m.studentCount}人`;

  // price display
  $("priceEarlyTxt").textContent   = fmtMoney(m.earlyPrice);
  $("priceStudentTxt").textContent = fmtMoney(m.studentPrice);

  // avg & cost
  $("avgPriceTxt").textContent = fmtMoney(m.avgPriceBeforeFee);
  $("costPerTxt").textContent  = fmtMoney(m.costPer);
  $("feeSubTxt").textContent   = `尾款刷卡平均手續費：${fmtMoney(m.avgCardFeePer)} / 人`;
  $("fixedTxt").textContent    = fmtMoney(m.fixed);
  $("targetGmTxt").textContent = Math.round(m.targetGM*100) + "%";

  // bus capacity hint
  if (m.targetPeople > RECOMMENDED_CAP){
    $("capNote").textContent = `你填的目標人數 ${m.targetPeople} 人超過 17 人，可能需要大型巴士加價`;
    $("capNote").style.borderColor = "rgba(255,176,32,.35)";
  }else{
    $("capNote").textContent = "建議出團人數：17人（目前巴士可載學生上限）";
    $("capNote").style.borderColor = "rgba(0,0,0,.06)";
  }
  $("peopleHint").textContent = `建議出團：17人｜你目前目標：${m.targetPeople}人`;
  $("busHint").textContent = (m.bigBusExtraPer > 0)
    ? `已加入大型巴士追加費：${fmtMoney(m.bigBusExtraPer)} / 人`
    : `大型巴士追加費目前為 0`;

  // rings: show percent in center; ring fill = current / targetGM (or clamp if targetGM=0)
  const p15 = m.targetGM > 0 ? clamp(m.gm15 / m.targetGM, 0, 1) : clamp(m.gm15,0,1);
  const p17 = m.targetGM > 0 ? clamp(m.gm17 / m.targetGM, 0, 1) : clamp(m.gm17,0,1);
  const pT  = m.targetGM > 0 ? clamp(m.gmTarget / m.targetGM, 0, 1) : clamp(m.gmTarget,0,1);

  setRing($("ring15"), p15, "var(--orange)");
  setRing($("ring17"), p17, "var(--gold)");
  setRing($("ringTarget"), pT, "var(--gold)");

  $("gm15Txt").textContent = fmtPct(m.gm15);
  $("gm17Txt").textContent = fmtPct(m.gm17);
  $("gmTargetTxt").textContent = fmtPct(m.gmTarget);

  // breakeven
  if (m.breakeven === Infinity){
    $("breakevenTxt").textContent = "—";
    $("riskPill").textContent = "售價低於成本，無法成團";
    setPillStyle("danger");
  }else{
    $("breakevenTxt").textContent = `${m.breakeven} 人`;

    if (m.targetPeople < m.breakeven){
      $("riskPill").textContent = "目標人數不足，風險高";
      setPillStyle("danger");
    }else if (m.gmTarget < m.targetGM){
      $("riskPill").textContent = "可成團，但毛利偏低";
      setPillStyle("warn");
    }else{
      $("riskPill").textContent = "狀態良好";
      setPillStyle("ok");
    }
  }

  // suggestion
  $("suggestNormalTxt").textContent =
    (Number.isFinite(m.suggestedNormal) && m.suggestedNormal !== Infinity)
      ? fmtMoney(m.suggestedNormal)
      : "NT$ —";

  // cost stack (meaningful)
  setMiniStack($("costStack"), [
    {name:"日方", value:m.japan, color:"rgba(42,125,255,.35)"},
    {name:"機票", value:m.flight, color:"rgba(255,106,43,.30)"},
    {name:"保險", value:m.ins, color:"rgba(47,184,107,.28)"},
    {name:"網卡", value:m.sim, color:"rgba(255,176,32,.28)"},
    {name:"手冊", value:m.book, color:"rgba(0,0,0,.10)"},
    {name:"巴士", value:m.bigBusExtraPer, color:"rgba(194,138,74,.25)"},
    {name:"刷卡", value:m.avgCardFeePer, color:"rgba(255,0,100,.12)"},
    {name:"其他", value:m.extraPer, color:"rgba(0,0,0,.06)"},
  ]);

  // margin curve + list
  const from = Math.max(1, Math.floor(Number($("rangeFrom").value)||10));
  const to   = Math.max(from, Math.floor(Number($("rangeTo").value)||28));
  const pts = [];
  const steps = 10;
  for (let i=0;i<steps;i++){
    const n = from + (to-from) * (i/(steps-1));
    pts.push(clamp(grossMarginRate(m, n), 0, 1));
  }
  makeLineSVG($("sparkMargin"), pts);
  renderMarginList(m, from, to);

  save();
}

function setPillStyle(type){
  const el = $("riskPill");
  if (type === "danger"){
    el.style.borderColor = "rgba(240,90,90,.35)";
    el.style.color = "rgba(240,90,90,.95)";
  }else if (type === "warn"){
    el.style.borderColor = "rgba(255,176,32,.35)";
    el.style.color = "rgba(160,110,0,.95)";
  }else{
    el.style.borderColor = "rgba(47,184,107,.30)";
    el.style.color = "rgba(20,120,70,.95)";
  }
}

function grossMarginRate(m, n){
  const revenue = m.avgPriceBeforeFee * n;
  const cost = m.costPer * n + m.fixed;
  return revenue > 0 ? (revenue - cost) / revenue : 0;
}
function grossProfit(m, n){
  const revenue = m.avgPriceBeforeFee * n;
  const cost = m.costPer * n + m.fixed;
  return revenue - cost;
}

function renderMarginList(m, from, to){
  const rows = [];
  for (let n=from; n<=to; n++){
    const gm = grossMarginRate(m, n);
    const gp = grossProfit(m, n);

    let icon = "✅";
    if (m.breakeven !== Infinity && n < m.breakeven) icon = "⛔";
    else if (gm < m.targetGM) icon = "⚠️";

    rows.push(`
      <div class="item">
        <div class="left">
          <div class="badge">${icon}</div>
          <div class="meta">
            <div class="t">${n} 人</div>
            <div class="s">平均售價 ${fmtMoney(m.avgPriceBeforeFee)} / 人　每人成本 ${fmtMoney(m.costPer)} / 人　固定成本 ${fmtMoney(m.fixed)}</div>
          </div>
        </div>
        <div class="right">
          <div class="gm">${fmtPct(gm)}</div>
          <div class="gp">毛利 ${fmtMoney(gp)}</div>
        </div>
      </div>
    `);
  }
  $("marginList").innerHTML = rows.join("");
}

// ---------- storage ----------
function save(){
  const data = { ticketMode };
  document.querySelectorAll("input, select").forEach(el=>{
    data[el.id] = el.value;
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}
function load(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try{
    const data = JSON.parse(raw);
    if (data.ticketMode) ticketMode = data.ticketMode;
    Object.keys(data).forEach(k=>{
      const el = document.getElementById(k);
      if (el) el.value = data[k];
    });
  }catch{}
}

// ---------- wiring ----------
function attachMoney(id){
  const input = $(id);
  input.addEventListener("input", ()=>{
    formatCommaKeepCursor(input);
    render();
  });
  input.addEventListener("blur", ()=>{
    const v = parseMoney(input.value);
    input.value = v ? v.toLocaleString("zh-TW") : "";
    render();
  });
}

function setMode(mode){
  ticketMode = mode;
  $("modeInclude").classList.toggle("active", mode==="include");
  $("modeExclude").classList.toggle("active", mode==="exclude");
  render();
}

function bind(){
  // money inputs
  ["priceNormal","earlyDiscount","studentBuffer","costJapan","costFlight","costInsurance","costSim","costBook","bigBusExtraPer","costExtraPer","adCostPerSignup","fixedOther"]
    .forEach(attachMoney);

  // number/select inputs
  ["targetPeople","earlyCount","studentCount","desiredPeople","targetGM","cardCount","cardFeeRate","rangeFrom","rangeTo","priceEnding"]
    .forEach(id=>{
      $(id).addEventListener("input", render);
      $(id).addEventListener("change", render);
    });

  $("modeInclude").addEventListener("click", ()=>setMode("include"));
  $("modeExclude").addEventListener("click", ()=>setMode("exclude"));

  $("resetBtn").addEventListener("click", ()=>{
    localStorage.removeItem(STORAGE_KEY);

    ticketMode = "include";
    $("targetPeople").value = 20;
    $("earlyCount").value = 6;
    $("studentCount").value = 4;
    $("desiredPeople").value = 15;

    $("priceNormal").value = "45,800";
    $("earlyDiscount").value = "2,000";
    $("studentBuffer").value = "2,000";
    $("priceEnding").value = "800";
    $("targetGM").value = 20;

    $("costJapan").value = "25,000";
    $("costFlight").value = "10,500";
    $("costInsurance").value = "600";
    $("costSim").value = "280";
    $("costBook").value = "100";
    $("bigBusExtraPer").value = "0";
    $("costExtraPer").value = "0";

    $("adCostPerSignup").value = "2,500";
    $("fixedOther").value = "0";

    $("cardCount").value = 2;      // 尾款刷卡人數（用人數）
    $("cardFeeRate").value = 2.4;

    $("rangeFrom").value = 10;
    $("rangeTo").value = 28;

    setMode("include");
  });
}

// init
load();
bind();
setMode(ticketMode);
render();