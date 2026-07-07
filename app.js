/* 빌드 브랜치 타임라인 — 규칙 엔진 + 렌더러 + 편집기
 *
 * 데이터(data.js)에는 "이벤트"(브랜치/패치)만 기록하고,
 * 레인별 버전 구간과 색 전환 시점은 아래 규칙 엔진이 자동 파생한다.
 *
 * 색 전환 규칙 (SPEC.md 참고):
 *  - 브랜치를 받는 레인(to): 브랜치 당일부터 해당 버전
 *  - 브랜치를 보낸 레인(from): sourceNext가 지정된 경우 다음 날부터 그 버전
 *  - 패치 레인의 단독(solo) 주차 버전: 직전 패치/핫픽스 다음 날부터
 *  - 핫픽스: 당일부터 색 전환
 *  - 정규(regular) 주차 버전은 브랜치 이벤트가 실제로 입력되기 전까지 절대 미리 칠하지 않음
 */
"use strict";

/* ── 날짜 유틸 ── */
function pd(s) { // "YYYY-MM-DD" → Date(local)
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fd(d) { // Date → "YYYY-MM-DD"
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(s, n) {
  const d = pd(s);
  d.setDate(d.getDate() + n);
  return fd(d);
}
function dayDiff(a, b) { return Math.round((pd(b) - pd(a)) / 86400000); }
function md(s) { const d = pd(s); return `${d.getMonth() + 1}/${d.getDate()}`; }
function snapMonday(s) { let d = s; while (pd(d).getDay() !== 1) d = addDays(d, -1); return d; }
const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"];

/* ── 버전 유틸 ── */
function bumpMinor(v, inc) { // "1.12.00" → "1.14.00"
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return "";
  return `${m[1]}.${String(Number(m[2]) + (inc || 2)).padStart(2, "0")}.00`;
}
function bumpHotfix(v) { // "1.10.00" → "1.10.01"
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return "";
  return `${m[1]}.${m[2]}.${String(Number(m[3]) + 1).padStart(2, "0")}`;
}

/* 브랜치 이벤트의 버전에 맞춰, 보낸 레인의 그 시점 버전을 정하던 설정을 소급 보정.
 * 예: 6/14 브랜치(sourceNext 1.14.00) 이후 6/26에 1.13.00을 브랜치하면
 *     MAINLINE이 6/26에 1.13.00이어야 하므로 6/14의 sourceNext를 1.13.00으로 고침. */
function syncSourceVersion(data, ev) {
  const X = ev.from, D = ev.date, V = ev.version;
  if (!V) return;
  let best = null; // X의 D 시점 버전을 정한 설정자 {kind, ref, eff}
  for (const b of data.branches) {
    if (b === ev) continue;
    if (b.from === X && b.sourceNext) {
      const eff = addDays(b.date, 1);
      if (eff <= D && (!best || eff > best.eff)) best = { kind: "next", ref: b, eff };
    }
    if (b.to === X && b.date <= D && (!best || b.date > best.eff)) {
      best = { kind: "recv", ref: b, eff: b.date };
    }
  }
  if (!best) {
    data.initialVersions = data.initialVersions || {};
    data.initialVersions[X] = V;
    return;
  }
  if (best.kind === "next") {
    best.ref.sourceNext = V;
  } else if (best.ref.version !== V) {
    best.ref.version = V;
    syncSourceVersion(data, best.ref); // 위 레인으로 연쇄 보정
  }
}

/* 버전 이름 전역 변경 — 버전은 빌드의 정체성이므로 모든 이벤트/색에서 함께 바뀜 */
function renameVersion(data, oldV, newV) {
  if (!oldV || !newV || oldV === newV) return;
  data.branches.forEach(b => {
    if (b.version === oldV) b.version = newV;
    if (b.sourceNext === oldV) b.sourceNext = newV;
  });
  data.patches.forEach(p => { if (p.version === oldV) p.version = newV; });
  const iv = data.initialVersions || {};
  Object.keys(iv).forEach(k => { if (iv[k] === oldV) iv[k] = newV; });
  const vc = data.versionColors || {};
  if (vc[oldV] && !vc[newV]) vc[newV] = vc[oldV];
  delete vc[oldV];
}

/* ── 규칙 엔진: 이벤트 → 레인별 버전 구간 ── */
function sortPatches(patches) {
  return [...patches].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1)
    : (a.type === b.type ? 0 : a.type === "hotfix" ? 1 : -1));
}

function deriveSegments(data) {
  const warnings = [];
  const laneIds = data.lanes.map(l => l.id);
  const transitions = {}; // laneId → [{date, ver}]
  laneIds.forEach(id => transitions[id] = []);

  for (const b of data.branches) {
    if (!laneIds.includes(b.from) || !laneIds.includes(b.to)) {
      warnings.push(`브랜치 ${b.date}: 알 수 없는 레인 (${b.from}→${b.to})`);
      continue;
    }
    transitions[b.to].push({ date: b.date, ver: b.version });
    if (b.sourceNext) {
      transitions[b.from].push({ date: addDays(b.date, 1), ver: b.sourceNext });
    }
  }

  const pl = data.patchLaneId;
  if (pl && laneIds.includes(pl)) {
    const ps = sortPatches(data.patches);
    ps.forEach((p, i) => {
      if (p.type === "hotfix") {
        transitions[pl].push({ date: p.date, ver: p.version });
      } else if (p.mode === "solo") {
        if (data.branches.some(b => b.to === pl && b.version === p.version)) {
          warnings.push(`${p.version}(${p.date}): 단독 주차로 표시됐지만 같은 버전의 브랜치 이벤트도 있음 — 주차 방식 확인 필요`);
        }
        if (i === 0) {
          warnings.push(`단독 주차 패치 ${p.version}(${p.date}): 직전 패치가 없어 시작일을 정할 수 없음`);
        } else {
          transitions[pl].push({ date: addDays(ps[i - 1].date, 1), ver: p.version });
        }
      }
      // regular 패치는 색 전환을 만들지 않음 — 브랜치 이벤트가 담당
    });
  }

  const segments = {};
  for (const id of laneIds) {
    const trs = transitions[id].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    for (let i = 1; i < trs.length; i++) {
      if (trs[i].date === trs[i - 1].date && trs[i].ver !== trs[i - 1].ver) {
        warnings.push(`${id}: ${trs[i].date}에 버전 전환이 2건 충돌 (${trs[i - 1].ver} / ${trs[i].ver})`);
      }
    }
    const segs = [];
    let curVer = (data.initialVersions || {})[id] || null;
    let curStart = data.startDate;
    for (const t of trs) {
      if (t.date <= data.startDate) { curVer = t.ver; continue; }
      if (t.date > data.endDate) continue;
      if (t.ver === curVer) continue;
      if (curVer) segs.push({ start: curStart, end: addDays(t.date, -1), ver: curVer });
      curVer = t.ver;
      curStart = t.date;
    }
    if (curVer) segs.push({ start: curStart, end: data.endDate, ver: curVer });
    segments[id] = segs;
  }

  // 브랜치 버전과 보낸 레인의 실제 버전이 다르면 경고 (있어선 안 되는 상태)
  const nameOf = id => { const l = data.lanes.find(l => l.id === id); return l ? l.name : id; };
  for (const b of data.branches) {
    const seg = (segments[b.from] || []).find(s => s.start <= b.date && b.date <= s.end);
    if (seg && b.version && seg.ver !== b.version) {
      warnings.push(`${md(b.date)} 브랜치 버전 불일치: ${nameOf(b.from)}이(가) ${seg.ver}인데 ${b.version}을(를) 브랜치함 — 해당 구간을 클릭해 버전을 맞춰주세요`);
    }
  }
  return { segments, warnings };
}

/* ── 색상 ── */
const FALLBACK_BGS = [
  "#FFECB3", "#FFE0B2", "#C8E6C9", "#BBDEFB", "#F8BBD9", "#EDE7F6",
  "#DCEDC8", "#B2EBF2", "#FFCDD2", "#C5CAE9", "#F0F4C3", "#B2DFDB",
  "#E1BEE7", "#FFCCBC", "#D7CCC8", "#CFD8DC",
];
function hexToHsl(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  let r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToHex(h, s, l) {
  const f = n => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return "#" + f(0) + f(8) + f(4);
}
function versionsInUse(data, segments) {
  const set = new Set();
  Object.values(segments).forEach(segs => segs.forEach(s => set.add(s.ver)));
  data.branches.forEach(b => { set.add(b.version); if (b.sourceNext) set.add(b.sourceNext); });
  data.patches.forEach(p => set.add(p.version));
  set.delete(""); set.delete(null); set.delete(undefined);
  return [...set].sort();
}
function resolveColors(data, versions) {
  const colors = { ...(data.versionColors || {}) };
  const used = new Set(Object.values(colors).map(c => c.toUpperCase()));
  let fi = 0;
  const nextFallback = () => {
    while (fi < FALLBACK_BGS.length && used.has(FALLBACK_BGS[fi].toUpperCase())) fi++;
    const c = FALLBACK_BGS[fi % FALLBACK_BGS.length]; fi++;
    return c;
  };
  for (const v of versions) { // 오름차순이므로 핫픽스의 직전 빌드가 먼저 결정됨
    if (colors[v]) continue;
    const m = v.match(/^(\d+\.\d+)\.(\d+)$/);
    const cc = m ? Number(m[2]) : 0;
    let prev = null;
    if (m && cc > 0) {
      // 핫픽스: 가장 가까운 직전 빌드(CC-1, CC-2, … , .00)의 색에서 한 단계 더 진하게.
      // 매 핫픽스마다 색이 달라져야 함 (빌드가 다르므로)
      for (let k = cc - 1; k >= 0; k--) {
        const pv = `${m[1]}.${String(k).padStart(2, "0")}`;
        if (colors[pv]) { prev = colors[pv]; break; }
      }
    }
    if (prev) {
      const [h, s, l] = hexToHsl(prev);
      colors[v] = hslToHex(h, Math.min(1, s + 0.08), Math.max(0.15, l - 0.08));
    } else {
      colors[v] = nextFallback();
    }
    used.add(colors[v].toUpperCase());
  }
  return colors;
}

/* ═══════════════ 이하 브라우저 전용 ═══════════════ */
if (typeof module !== "undefined") {
  module.exports = { deriveSegments, resolveColors, versionsInUse, addDays, sortPatches, bumpMinor, bumpHotfix, syncSourceVersion, renameVersion };
}
if (typeof document !== "undefined") (function () {

  const LS_KEY = "build-timeline-draft-v1";
  let data = deepCopy(window.TIMELINE_DATA);
  let dirty = false;
  let lastSegments = null;
  let lastColors = null;
  let firstScroll = true;

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }
  function tint(hex) { return hex ? hex + "40" : "#B0BEC540"; } // 25% 투명 배경
  function laneVersionAt(laneId, date) {
    const segs = (lastSegments || {})[laneId] || [];
    const seg = segs.find(s => s.start <= date && date <= s.end);
    return seg ? seg.ver : "";
  }

  /* 모든 브랜치에 대해 "보낸 레인 버전 = 브랜치 버전" 소급 보정 (과거 데이터 자동 치유) */
  function healBranchVersions() {
    [...data.branches]
      .sort((a, b) => a.date < b.date ? -1 : 1)
      .forEach(b => syncSourceVersion(data, b));
  }

  /* ── 렌더링 ── */
  function render() {
    closePopover();
    healBranchVersions();
    const { segments, warnings } = deriveSegments(data);
    const versions = versionsInUse(data, segments);
    const colors = resolveColors(data, versions);
    lastSegments = segments;
    lastColors = colors;
    document.getElementById("title-bar").textContent = data.title;
    document.title = data.title;
    renderGrid(segments, colors);
    renderEditor(versions, colors, warnings);
    if (firstScroll) {
      firstScroll = false;
      const wrap = document.getElementById("grid-wrap");
      requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
    }
  }

  function renderGrid(segments, colors) {
    const days = [];
    for (let d = data.startDate; d <= data.endDate; d = addDays(d, 1)) days.push(d);
    const patchByDate = {};
    sortPatches(data.patches).forEach(p => (patchByDate[p.date] = patchByDate[p.date] || []).push(p));
    const patchRowCount = Math.max(2, ...Object.values(patchByDate).map(a => a.length));
    const patchDates = new Set(Object.keys(patchByDate));

    const tbl = document.createElement("table");
    tbl.className = "grid";

    // 헤더: 요일 + 날짜
    let weekToggle = true;
    const trW = document.createElement("tr"); trW.className = "hdr-row";
    const trD = document.createElement("tr"); trD.className = "hdr-row hdr-row2";
    trW.appendChild(th("", "corner hdr"));
    trD.appendChild(th("BRANCH / DATE", "corner hdr"));
    for (const d of days) {
      const dt = pd(d), wd = dt.getDay();
      if (wd === 1) weekToggle = !weekToggle;
      let cls = "hdr " + (patchDates.has(d) ? "hdr-patch" : wd === 0 || wd === 6 ? "hdr-weekend" : weekToggle ? "hdr-a" : "hdr-b");
      trW.appendChild(th(WEEKDAY_KR[wd], cls));
      trD.appendChild(th(md(d), cls));
    }
    tbl.append(trW, trD);

    // 레인 + 브릿지 행
    data.lanes.forEach((lane, li) => {
      const tr = document.createElement("tr");
      const lb = th(lane.name, "lane-label");
      lb.style.background = lane.labelBg || "#455A64";
      tr.appendChild(lb);
      const segs = segments[lane.id] || [];
      let d = data.startDate;
      let si = 0;
      while (d <= data.endDate) {
        while (si < segs.length && segs[si].end < d) si++;
        const seg = si < segs.length && segs[si].start <= d && d <= segs[si].end ? segs[si] : null;
        if (seg) {
          const end = seg.end < data.endDate ? seg.end : data.endDate;
          const span = dayDiff(d, end) + 1;
          const td = cell(seg.ver, "seg");
          td.colSpan = span;
          td.style.background = colors[seg.ver];
          td.dataset.tip = `${lane.name} · ${seg.ver}\n${md(seg.start)} ~ ${md(seg.end)}\n(편집 모드에서 클릭하여 버전/색 수정)`;
          td.dataset.segVer = seg.ver;
          td.dataset.segLane = lane.id;
          td.dataset.segStart = seg.start;
          td.dataset.segEnd = seg.end;
          tr.appendChild(td);
          d = addDays(end, 1);
        } else {
          tr.appendChild(cell("", "empty"));
          d = addDays(d, 1);
        }
      }
      tbl.appendChild(tr);

      // 다음 레인과의 브릿지 행
      if (li < data.lanes.length - 1) {
        const next = data.lanes[li + 1];
        const trB = document.createElement("tr"); trB.className = "bridge-row";
        trB.appendChild(th("", "bridge-label"));
        for (const day of days) {
          const ev = data.branches.find(b => b.date === day &&
            ((b.from === lane.id && b.to === next.id) || (b.from === next.id && b.to === lane.id)));
          if (ev) {
            const td = cell(ev.time || "", "bridge-ev");
            td.style.background = colors[ev.version];
            td.dataset.tip = `브랜치 ${lane.name} → ${next.name}\n${ev.version} · ${md(ev.date)} ${ev.time || ""}\n(편집 모드에서 클릭하여 수정)`;
            td.dataset.branchIdx = data.branches.indexOf(ev);
            trB.appendChild(td);
          } else {
            const td = cell("", "empty bridge-empty");
            td.dataset.bridgeNew = "";
            td.dataset.date = day;
            td.dataset.upper = lane.id;
            td.dataset.lower = next.id;
            trB.appendChild(td);
          }
        }
        tbl.appendChild(trB);
      }
    });

    // 패치 행
    for (let r = 0; r < patchRowCount; r++) {
      const tr = document.createElement("tr"); tr.className = "patch-row";
      tr.appendChild(th("", "patch-label"));
      for (const day of days) {
        const p = (patchByDate[day] || [])[r];
        if (p) {
          const label = p.label || `${p.version} ${p.type === "hotfix" ? "핫픽스" : "패치"}`;
          const td = cell(label, "patch-ev");
          td.dataset.tip = `${label}\n${md(day)}(${WEEKDAY_KR[pd(day).getDay()]})${p.type !== "hotfix" ? " · " + (p.mode === "solo" ? "ALPHA 단독 주차" : "정규 브랜치 주차") : ""}\n(편집 모드에서 클릭하여 수정)`;
          td.dataset.patchIdx = data.patches.indexOf(p);
          tr.appendChild(td);
        } else {
          const td = cell("", "empty patch-empty");
          td.dataset.patchNew = "";
          td.dataset.date = day;
          tr.appendChild(td);
        }
      }
      tbl.appendChild(tr);
    }

    const wrap = document.getElementById("grid-wrap");
    wrap.innerHTML = "";
    wrap.appendChild(tbl);
  }

  function th(text, cls) { const e = document.createElement("th"); e.textContent = text; e.className = cls; return e; }
  function cell(text, cls) { const e = document.createElement("td"); e.textContent = text; e.className = cls; return e; }

  /* ── 툴팁 ── */
  const tip = document.getElementById("tooltip");
  document.addEventListener("mouseover", e => {
    const t = e.target.closest("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
  });
  document.addEventListener("mousemove", e => {
    if (tip.hidden) return;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(e.clientY + 16, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = x + "px"; tip.style.top = y + "px";
  });

  /* ── 팝오버 ── */
  const pop = document.getElementById("popover");
  function closePopover() { pop.hidden = true; pop.innerHTML = ""; }
  function openPopover(anchor, build) {
    pop.innerHTML = "";
    build(pop);
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    let x = Math.min(r.left, window.innerWidth - pop.offsetWidth - 10);
    let y = r.bottom + 6;
    if (y + pop.offsetHeight > window.innerHeight - 10) y = Math.max(10, r.top - pop.offsetHeight - 6);
    pop.style.left = Math.max(10, x) + "px";
    pop.style.top = y + "px";
  }
  document.addEventListener("click", e => {
    if (pop.hidden) return;
    if (pop.contains(e.target)) return;
    if (e.target.closest("td[data-bridge-new],td[data-branch-idx],td[data-patch-idx],td[data-seg-ver]")) return;
    closePopover();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closePopover(); });

  function pField(label, input) {
    const r = document.createElement("div"); r.className = "ed-field";
    const l = document.createElement("label"); l.textContent = label;
    r.append(l, input);
    return r;
  }
  function pIn(type, value, placeholder) {
    const i = document.createElement("input");
    i.type = type; i.value = value || "";
    if (placeholder) i.placeholder = placeholder;
    return i;
  }
  function pSel(pairs, value) {
    const s = document.createElement("select");
    for (const [v, label] of pairs) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label; if (v === value) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }
  function pTitle(text) { const h = document.createElement("h4"); h.textContent = text; return h; }
  function laneName(id) { const l = data.lanes.find(l => l.id === id); return l ? l.name : id; }

  /* 브랜치 생성 팝오버 (레인 사이 빈 칸 클릭) */
  function popBridgeNew(td) {
    const date = td.dataset.date, upper = td.dataset.upper, lower = td.dataset.lower;
    const upperVer = laneVersionAt(upper, date);
    const isTopLane = data.lanes[0] && data.lanes[0].id === upper;
    openPopover(td, box => {
      box.appendChild(pTitle(`브랜치 · ${md(date)}(${WEEKDAY_KR[pd(date).getDay()]}) · ${laneName(upper)} → ${laneName(lower)}`));
      const time = pIn("time", "22:00");
      const ver = pIn("text", upperVer, "버전");
      const next = pIn("text", isTopLane && upperVer ? bumpMinor(upperVer) : "", "비우면 버전 유지");
      box.appendChild(pField("시간", time));
      box.appendChild(pField("버전", ver));
      box.appendChild(pField(`${laneName(upper)} 다음 버전`, next));
      const row = document.createElement("div"); row.className = "pop-actions";
      const ok = document.createElement("button"); ok.className = "ed-btn primary"; ok.textContent = "브랜치 생성";
      ok.addEventListener("click", () => {
        if (!ver.value.trim()) { alert("버전을 입력하세요."); return; }
        const ev = { date, time: time.value, from: upper, to: lower, version: ver.value.trim() };
        if (next.value.trim()) ev.sourceNext = next.value.trim();
        data.branches.push(ev);
        syncSourceVersion(data, ev); // 보낸 레인이 이 시점에 이 버전이 되도록 소급 보정
        // 이 브랜치가 패치 레인으로 들어가면, 같은 버전의 단독 주차 패치는 정규로 자동 전환
        if (lower === data.patchLaneId) {
          data.patches.forEach(p => { if (p.version === ev.version && p.mode === "solo") p.mode = "regular"; });
        }
        touch();
      });
      const cancel = document.createElement("button"); cancel.className = "ed-btn"; cancel.textContent = "취소";
      cancel.addEventListener("click", closePopover);
      row.append(ok, cancel);
      box.appendChild(row);
    });
  }

  /* 브랜치 수정/삭제 팝오버 */
  function popBridgeEdit(td) {
    const idx = Number(td.dataset.branchIdx);
    const b = data.branches[idx];
    if (!b) return;
    openPopover(td, box => {
      box.appendChild(pTitle(`브랜치 · ${md(b.date)}(${WEEKDAY_KR[pd(b.date).getDay()]}) · ${laneName(b.from)} → ${laneName(b.to)}`));
      const date = pIn("date", b.date);
      const time = pIn("time", b.time || "");
      const ver = pIn("text", b.version, "버전");
      const next = pIn("text", b.sourceNext || "", "비우면 버전 유지");
      box.appendChild(pField("날짜", date));
      box.appendChild(pField("시간", time));
      box.appendChild(pField("버전", ver));
      box.appendChild(pField(`${laneName(b.from)} 다음 버전`, next));
      const row = document.createElement("div"); row.className = "pop-actions";
      const ok = document.createElement("button"); ok.className = "ed-btn primary"; ok.textContent = "저장";
      ok.addEventListener("click", () => {
        if (date.value) b.date = date.value;
        b.time = time.value;
        b.version = ver.value.trim();
        if (next.value.trim()) b.sourceNext = next.value.trim(); else delete b.sourceNext;
        syncSourceVersion(data, b);
        touch();
      });
      const del = document.createElement("button"); del.className = "ed-btn danger"; del.textContent = "삭제";
      del.addEventListener("click", () => { data.branches.splice(idx, 1); touch(); });
      row.append(ok, del);
      box.appendChild(row);
    });
  }

  /* 패치 수정/삭제 팝오버 */
  function popPatchEdit(td) {
    const idx = Number(td.dataset.patchIdx);
    const p = data.patches[idx];
    if (!p) return;
    openPopover(td, box => {
      box.appendChild(pTitle(`${p.type === "hotfix" ? "핫픽스" : "패치"} · ${md(p.date)}(${WEEKDAY_KR[pd(p.date).getDay()]})`));
      const date = pIn("date", p.date);
      const ver = pIn("text", p.version, "버전");
      const type = pSel([["patch", "패치"], ["hotfix", "핫픽스"]], p.type);
      const mode = pSel([["regular", "정규 브랜치 주차"], ["solo", "단독 주차"]], p.mode || "regular");
      mode.disabled = p.type === "hotfix";
      type.addEventListener("change", () => { mode.disabled = type.value === "hotfix"; });
      const label = pIn("text", p.label || "", "비우면 자동 (버전 패치)");
      box.appendChild(pField("날짜", date));
      box.appendChild(pField("버전", ver));
      box.appendChild(pField("종류", type));
      box.appendChild(pField("주차 방식", mode));
      box.appendChild(pField("표시 텍스트", label));
      const row = document.createElement("div"); row.className = "pop-actions";
      const ok = document.createElement("button"); ok.className = "ed-btn primary"; ok.textContent = "저장";
      ok.addEventListener("click", () => {
        if (date.value) p.date = date.value;
        p.version = ver.value.trim();
        p.type = type.value;
        if (p.type === "hotfix") delete p.mode; else p.mode = mode.value;
        if (label.value.trim()) p.label = label.value.trim(); else delete p.label;
        touch();
      });
      const del = document.createElement("button"); del.className = "ed-btn danger"; del.textContent = "삭제";
      del.addEventListener("click", () => { data.patches.splice(idx, 1); touch(); });
      row.append(ok, del);
      box.appendChild(row);
    });
  }

  /* 레인 구간 클릭 → 버전/색 수정 팝오버 */
  function popSegEdit(td) {
    const oldVer = td.dataset.segVer;
    const laneId = td.dataset.segLane;
    openPopover(td, box => {
      box.appendChild(pTitle(`${laneName(laneId)} · ${oldVer} · ${md(td.dataset.segStart)} ~ ${md(td.dataset.segEnd)}`));
      const ver = pIn("text", oldVer, "버전");
      const col = document.createElement("input");
      col.type = "color"; col.value = (lastColors || {})[oldVer] || "#CCCCCC";
      box.appendChild(pField("버전", ver));
      box.appendChild(pField("색", col));
      const hint = document.createElement("div");
      hint.className = "ed-hint";
      hint.textContent = "버전을 바꾸면 이 버전을 쓰는 모든 이벤트(브랜치/패치)가 함께 바뀝니다.";
      box.appendChild(hint);
      const row = document.createElement("div"); row.className = "pop-actions";
      const ok = document.createElement("button"); ok.className = "ed-btn primary"; ok.textContent = "저장";
      ok.addEventListener("click", () => {
        const newVer = ver.value.trim();
        if (!newVer) { alert("버전을 입력하세요."); return; }
        renameVersion(data, oldVer, newVer);
        // 이 구간이 initialVersions에서 온 경우도 함께 갱신
        const iv = data.initialVersions || {};
        if (iv[laneId] === oldVer) iv[laneId] = newVer;
        const before = (lastColors || {})[oldVer];
        if (col.value.toUpperCase() !== (before || "").toUpperCase()) {
          data.versionColors = data.versionColors || {};
          data.versionColors[newVer] = col.value;
        }
        touch();
      });
      const cancel = document.createElement("button"); cancel.className = "ed-btn"; cancel.textContent = "취소";
      cancel.addEventListener("click", closePopover);
      row.append(ok, cancel);
      box.appendChild(row);
    });
  }

  /* 패치 빈 칸 클릭 → 인라인 입력. "패치"/"핫픽스" 단어로 종류를, 숫자로 버전을 자동 인식 */
  function inlinePatchInput(td) {
    const date = td.dataset.date;
    td.textContent = "";
    const inp = document.createElement("input");
    inp.className = "cell-input";
    inp.placeholder = "패치 / 핫픽스";
    td.appendChild(inp);
    inp.focus();
    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const text = inp.value.trim();
      if (!text) { render(); return; }
      const type = /핫픽스|hotfix/i.test(text) ? "hotfix" : "patch";
      let ver = (text.match(/\d+\.\d+\.\d+/) || [])[0] || "";
      if (!ver) {
        const laneVer = laneVersionAt(data.patchLaneId, date);
        ver = type === "hotfix" ? (bumpHotfix(laneVer) || laneVer) : laneVer;
      }
      if (!ver) { alert("버전을 인식할 수 없습니다. 예: 1.12.00 패치"); render(); return; }
      const ev = { date, version: ver, type };
      if (type === "patch") {
        ev.mode = data.branches.some(b => b.to === data.patchLaneId && b.version === ver) ? "regular" : "solo";
      }
      const auto = `${ver} ${type === "hotfix" ? "핫픽스" : "패치"}`;
      if (text !== auto && !/^(패치|핫픽스)$/.test(text) && !/^\d+\.\d+\.\d+$/.test(text)) ev.label = text;
      data.patches.push(ev);
      touch();
    };
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") { done = true; render(); }
    });
    inp.addEventListener("blur", commit);
  }

  /* 캘린더 직접 편집 — 편집 모드에서만 동작 */
  document.getElementById("grid-wrap").addEventListener("click", e => {
    if (!document.body.classList.contains("editing")) return;
    const td = e.target.closest("td");
    if (!td) return;
    if (td.querySelector("input")) return; // 인라인 입력 중
    if (td.dataset.bridgeNew !== undefined) popBridgeNew(td);
    else if (td.dataset.branchIdx !== undefined) popBridgeEdit(td);
    else if (td.dataset.patchNew !== undefined) { closePopover(); inlinePatchInput(td); }
    else if (td.dataset.patchIdx !== undefined) popPatchEdit(td);
    else if (td.dataset.segVer !== undefined) popSegEdit(td);
  });

  /* ── 편집 패널 ── */
  function renderEditor(versions, colors, warnings) {
    const el = document.getElementById("editor-body");
    el.innerHTML = "";

    el.appendChild(div("ed-hint ed-hint-top",
      "캘린더에서 바로 편집할 수 있습니다 — 레인 사이 빈 칸 클릭 = 브랜치 생성, " +
      "패치 행 빈 칸 클릭 = 패치 입력(“패치”/“핫픽스”라고만 쳐도 버전 자동 인식), " +
      "레인 구간 클릭 = 버전/색 수정, 기존 셀 클릭 = 수정/삭제. " +
      "브랜치 버전을 지정하면 보낸 레인의 버전이 자동으로 맞춰집니다."));

    if (warnings.length) {
      const w = div("ed-warn");
      w.innerHTML = "<b>⚠ 확인 필요</b><br>" + warnings.map(esc).join("<br>");
      el.appendChild(w);
    }

    // 기본 설정 + 기간 프리셋
    const presets = div("ed-item");
    [["최근 4주", 4], ["최근 8주", 8], ["전체", 0]].forEach(([label, weeks]) => {
      presets.appendChild(btn(label, () => applyPreset(weeks)));
    });
    el.appendChild(section("기본 설정", [
      fieldRow("타이틀", inputEl("text", data.title, v => { data.title = v; })),
      fieldRow("시작일", inputEl("date", data.startDate, v => { if (v) data.startDate = v; })),
      fieldRow("종료일", inputEl("date", data.endDate, v => { if (v) data.endDate = v; })),
      fieldRow("표시 기간", presets),
    ]));

    // 레인
    const laneRows = data.lanes.map((lane, i) => {
      const row = div("ed-item");
      stripe(row, lane.labelBg || "#455A64");
      row.append(
        inputEl("text", lane.name, v => { lane.name = v; }, "레인 이름", "w-name"),
        colorEl(lane.labelBg || "#455A64", v => { lane.labelBg = v; }),
        inputEl("text", (data.initialVersions || {})[lane.id] || "", v => {
          data.initialVersions = data.initialVersions || {};
          if (v) data.initialVersions[lane.id] = v; else delete data.initialVersions[lane.id];
        }, "시작 버전", "w-ver"),
        btn("↑", () => { if (i > 0) { [data.lanes[i - 1], data.lanes[i]] = [data.lanes[i], data.lanes[i - 1]]; touch(); } }),
        btn("↓", () => { if (i < data.lanes.length - 1) { [data.lanes[i + 1], data.lanes[i]] = [data.lanes[i], data.lanes[i + 1]]; touch(); } }),
        btn("✕", () => {
          if (data.branches.some(b => b.from === lane.id || b.to === lane.id)) {
            alert("이 레인을 참조하는 브랜치 이벤트가 있어 삭제할 수 없습니다."); return;
          }
          data.lanes.splice(i, 1); touch();
        }, "danger"),
      );
      return row;
    });
    laneRows.push(fieldRow("패치 발생 레인",
      selectEl(data.lanes.map(l => [l.id, l.name]), data.patchLaneId, v => { data.patchLaneId = v; })));
    laneRows.push(btn("+ 레인 추가", () => {
      const id = "lane" + Date.now().toString(36);
      data.lanes.push({ id, name: "NEW LANE", labelBg: "#455A64" }); touch();
    }, "add"));
    el.appendChild(section("레인 (위→아래 순서)", laneRows));

    // 브랜치 이벤트 — 최신순, 표시 기간 이전은 접기
    const brSorted = [...data.branches].sort((a, b) => a.date < b.date ? 1 : -1);
    const brRow = b => {
      const row = div("ed-item ed-grid");
      stripe(row, colors[b.version]);
      row.append(
        inputEl("date", b.date, v => { if (v) b.date = v; }),
        inputEl("time", b.time || "", v => { b.time = v; }),
        selectEl(data.lanes.map(l => [l.id, l.name]), b.from, v => { b.from = v; }),
        span("→"),
        selectEl(data.lanes.map(l => [l.id, l.name]), b.to, v => { b.to = v; }),
        inputEl("text", b.version, v => { b.version = v; syncSourceVersion(data, b); }, "버전", "w-ver"),
        inputEl("text", b.sourceNext || "", v => { if (v) b.sourceNext = v; else delete b.sourceNext; }, "보낸 레인 다음 버전", "w-ver"),
        btn("✕", () => { data.branches.splice(data.branches.indexOf(b), 1); touch(); }, "danger"),
      );
      return row;
    };
    const brCur = brSorted.filter(b => b.date >= data.startDate);
    const brPast = brSorted.filter(b => b.date < data.startDate);
    const brRows = brCur.map(brRow);
    if (brPast.length) brRows.push(foldPast(`지난 브랜치 ${brPast.length}건`, brPast.map(brRow)));
    brRows.push(btn("+ 브랜치 추가", () => {
      const last = data.branches[data.branches.length - 1];
      data.branches.push({
        date: last ? addDays(last.date, 7) : data.startDate, time: "22:00",
        from: data.lanes[0].id, to: (data.lanes[1] || data.lanes[0]).id, version: "",
      }); touch();
    }, "add"));
    el.appendChild(section("브랜치 이벤트", brRows));

    // 패치 이벤트 — 최신순, 표시 기간 이전은 접기
    const paSorted = sortPatches(data.patches).reverse();
    const paRow = p => {
      const row = div("ed-item ed-grid");
      stripe(row, colors[p.version]);
      row.append(
        inputEl("date", p.date, v => { if (v) p.date = v; }),
        inputEl("text", p.version, v => { p.version = v; }, "버전", "w-ver"),
        selectEl([["patch", "패치"], ["hotfix", "핫픽스"]], p.type, v => {
          p.type = v;
          if (v === "hotfix") delete p.mode; else p.mode = p.mode || "regular";
        }),
        p.type === "hotfix" ? span("") :
          selectEl([["regular", "정규 브랜치 주차"], ["solo", "단독 주차"]], p.mode || "regular", v => { p.mode = v; }),
        btn("✕", () => { data.patches.splice(data.patches.indexOf(p), 1); touch(); }, "danger"),
      );
      return row;
    };
    const paCur = paSorted.filter(p => p.date >= data.startDate);
    const paPast = paSorted.filter(p => p.date < data.startDate);
    const paRows = paCur.map(paRow);
    if (paPast.length) paRows.push(foldPast(`지난 패치 ${paPast.length}건`, paPast.map(paRow)));
    paRows.push(div("ed-hint", "단독 주차 패치는 직전 패치 다음 날부터 패치 레인 색이 전환됩니다. 정규 주차 버전은 브랜치 이벤트를 입력해야만 색이 칠해집니다(미리 칠하지 않음)."));
    paRows.push(btn("+ 패치 추가", () => {
      const last = sortPatches(data.patches).pop();
      data.patches.push({ date: last ? addDays(last.date, 7) : data.startDate, version: "", type: "patch", mode: "regular" });
      touch();
    }, "add"));
    el.appendChild(section("패치 / 핫픽스", paRows));

    // 버전 색상
    const vcRows = versions.map(v => {
      const row = div("ed-item");
      stripe(row, colors[v]);
      row.append(
        span(v, "w-ver ver-name"),
        colorEl(colors[v], val => {
          data.versionColors = data.versionColors || {};
          data.versionColors[v] = val;
        }),
        span((data.versionColors || {})[v] ? "수동" : "자동", "ver-mode"),
      );
      return row;
    });
    vcRows.push(div("ed-hint", "새 버전 색은 자동 배정됩니다(핫픽스는 기본 버전의 진한 변형). 색을 바꾸면 수동으로 고정됩니다."));
    el.appendChild(section("버전 색상", vcRows));

    // 저장 / 불러오기
    const fileIn = document.createElement("input");
    fileIn.type = "file"; fileIn.accept = ".js,.json"; fileIn.hidden = true;
    fileIn.addEventListener("change", () => {
      const f = fileIn.files[0];
      if (!f) return;
      f.text().then(txt => {
        try {
          const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
          data = JSON.parse(txt.slice(s, e + 1));
          dirty = true; saveDraft(); render();
        } catch (err) { alert("파일을 해석할 수 없습니다: " + err.message); }
      });
    });
    el.appendChild(section("저장 / 불러오기", [
      btn("⬇ data.js 다운로드", downloadData, "primary"),
      btn("파일 불러오기 (.js/.json)", () => fileIn.click()),
      btn("게시된 원본으로 되돌리기", () => {
        if (!confirm("편집 내용을 버리고 게시된 data.js 상태로 되돌릴까요?")) return;
        data = deepCopy(window.TIMELINE_DATA);
        dirty = false; localStorage.removeItem(LS_KEY); render();
      }, "danger"),
      div("ed-hint", "다운로드한 data.js를 Claude에게 전달하거나 레포의 data.js에 덮어쓴 뒤 push하면 팀 전체에 반영됩니다. 편집 중인 내용은 이 브라우저에 자동 임시 저장됩니다."),
      fileIn,
    ]));
  }

  function applyPreset(weeks) {
    const dates = [...data.branches.map(b => b.date), ...data.patches.map(p => p.date)];
    if (!dates.length) return;
    const maxD = dates.reduce((a, b) => a > b ? a : b);
    const minD = dates.reduce((a, b) => a < b ? a : b);
    data.endDate = maxD;
    data.startDate = snapMonday(weeks ? addDays(maxD, -(weeks * 7 - 1)) : minD);
    if (data.startDate < minD && weeks) data.startDate = snapMonday(minD);
    touch();
  }

  /* ── 편집기 DOM 헬퍼 ── */
  function div(cls, text) { const e = document.createElement("div"); e.className = cls; if (text) e.textContent = text; return e; }
  function span(text, cls) { const e = document.createElement("span"); e.textContent = text; if (cls) e.className = cls; return e; }
  function esc(s) { const e = document.createElement("span"); e.textContent = s; return e.innerHTML; }
  function stripe(row, color) {
    row.style.borderLeft = `4px solid ${color || "#B0BEC5"}`;
    row.style.background = tint(color);
  }
  function foldPast(label, rows) {
    const d = document.createElement("details");
    d.className = "past-events";
    const s = document.createElement("summary");
    s.textContent = label + " (표시 기간 이전)";
    d.appendChild(s);
    rows.forEach(r => d.appendChild(r));
    return d;
  }
  function section(titleText, children) {
    const s = div("ed-section");
    const h = document.createElement("h3"); h.textContent = titleText;
    s.appendChild(h);
    children.forEach(c => s.appendChild(c));
    return s;
  }
  function fieldRow(label, input) {
    const r = div("ed-field");
    const l = document.createElement("label"); l.textContent = label;
    r.append(l, input);
    return r;
  }
  function inputEl(type, value, onchange, placeholder, cls) {
    const i = document.createElement("input");
    i.type = type; i.value = value;
    if (placeholder) i.placeholder = placeholder;
    if (cls) i.className = cls;
    i.addEventListener("change", () => { onchange(i.value.trim ? i.value.trim() : i.value); touch(); });
    return i;
  }
  function colorEl(value, onchange) {
    const i = document.createElement("input");
    i.type = "color"; i.value = value;
    i.addEventListener("change", () => { onchange(i.value); touch(); });
    return i;
  }
  function selectEl(pairs, value, onchange) {
    const s = document.createElement("select");
    for (const [v, label] of pairs) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label; if (v === value) o.selected = true;
      s.appendChild(o);
    }
    s.addEventListener("change", () => { onchange(s.value); touch(); });
    return s;
  }
  function btn(label, onclick, cls) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.className = "ed-btn " + (cls || "");
    b.addEventListener("click", onclick);
    return b;
  }
  function touch() { dirty = true; saveDraft(); render(); }

  /* ── 임시 저장 / 내보내기 ── */
  function saveDraft() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { /* 저장 불가 환경 무시 */ }
  }
  function downloadData() {
    // 내보내기 전에 자동 배정 색을 데이터에 고정(다음 주에 버전이 늘어도 기존 색 유지)
    const { segments } = deriveSegments(data);
    const colors = resolveColors(data, versionsInUse(data, segments));
    const out = deepCopy(data);
    out.versionColors = colors;
    const txt = "// 빌드 브랜치 타임라인 데이터\n" +
      "// 이 파일만 갱신하면 index.html이 규칙에 따라 타임라인을 자동으로 그립니다.\n" +
      "window.TIMELINE_DATA = " + JSON.stringify(out, null, 2) + ";\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "text/javascript" }));
    a.download = "data.js";
    a.click();
    URL.revokeObjectURL(a.href);
    dirty = false;
  }

  /* ── 초기화 ── */
  document.getElementById("edit-toggle").addEventListener("click", () => {
    document.body.classList.toggle("editing");
  });
  if (location.search.includes("edit=1")) document.body.classList.add("editing");
  window.addEventListener("beforeunload", e => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  // 임시 저장본 안내 배너
  (function () {
    let draft = null;
    try { draft = localStorage.getItem(LS_KEY); } catch (e) { /* ignore */ }
    if (draft && draft !== JSON.stringify(window.TIMELINE_DATA)) {
      const bar = document.getElementById("draft-banner");
      bar.hidden = false;
      document.getElementById("draft-load").addEventListener("click", () => {
        try { data = JSON.parse(draft); dirty = true; render(); } catch (e) { alert("임시 저장본이 손상되었습니다."); }
        bar.hidden = true;
      });
      document.getElementById("draft-discard").addEventListener("click", () => {
        localStorage.removeItem(LS_KEY);
        bar.hidden = true;
      });
    }
  })();

  /* ── 셀프테스트 (?selftest=1) ── */
  if (location.search.includes("selftest")) {
    const expected = {
      mainline: [["2026-05-11", "2026-05-11", "1.08.00"], ["2026-05-12", "2026-05-26", "1.10.00"],
                 ["2026-05-27", "2026-06-14", "1.12.00"], ["2026-06-15", "2026-06-15", "1.14.00"]],
      beta:     [["2026-05-11", "2026-05-25", "1.08.00"], ["2026-05-26", "2026-06-13", "1.10.00"],
                 ["2026-06-14", "2026-06-15", "1.12.00"]],
      alpha:    [["2026-05-11", "2026-05-18", "1.07.00"], ["2026-05-19", "2026-05-22", "1.08.00"],
                 ["2026-05-23", "2026-05-31", "1.09.00"], ["2026-06-01", "2026-06-05", "1.10.00"],
                 ["2026-06-06", "2026-06-06", "1.10.01"], ["2026-06-07", "2026-06-15", "1.11.00"]],
    };
    const { segments, warnings } = deriveSegments(window.TIMELINE_DATA);
    const lines = [];
    let pass = true;
    for (const lane of Object.keys(expected)) {
      const got = (segments[lane] || []).map(s => [s.start, s.end, s.ver]);
      const ok = JSON.stringify(got) === JSON.stringify(expected[lane]);
      if (!ok) pass = false;
      lines.push(`${lane}: ${ok ? "PASS" : "FAIL"}`);
      if (!ok) lines.push(`  expected ${JSON.stringify(expected[lane])}\n  got      ${JSON.stringify(got)}`);
    }
    // 소급 보정 시나리오: 6/14 브랜치(sourceNext 1.14.00) 후 6/26에 1.13.00 브랜치
    const syncData = {
      lanes: [{ id: "m" }, { id: "b" }, { id: "a" }],
      initialVersions: { m: "1.12.00" }, patchLaneId: "a", patches: [],
      branches: [{ date: "2026-06-14", from: "m", to: "b", version: "1.12.00", sourceNext: "1.14.00" }],
    };
    const syncEv = { date: "2026-06-26", from: "m", to: "b", version: "1.13.00" };
    syncData.branches.push(syncEv);
    syncSourceVersion(syncData, syncEv);
    // 연쇄 보정: b가 받은 버전을 바꾸면 m의 설정까지 올라가서 고침
    const chainEv = { date: "2026-06-28", from: "b", to: "a", version: "1.13.50" };
    syncData.branches.push(chainEv);
    syncSourceVersion(syncData, chainEv);
    // 전역 이름 변경
    const rnData = {
      branches: [{ date: "2026-06-14", from: "m", to: "b", version: "1.12.00", sourceNext: "1.14.00" }],
      patches: [{ date: "2026-06-19", version: "1.14.00", type: "patch" }],
      initialVersions: {}, versionColors: { "1.14.00": "#DCEDC8" },
    };
    renameVersion(rnData, "1.14.00", "1.13.00");
    const hfColors = resolveColors(
      { versionColors: { "1.12.00": "#EDE7F6" } },
      ["1.12.00", "1.12.01", "1.12.02"]);
    const unit = [
      ["bumpMinor", bumpMinor("1.12.00"), "1.14.00"],
      ["bumpHotfix", bumpHotfix("1.10.00"), "1.10.01"],
      ["bumpHotfix2", bumpHotfix("1.10.01"), "1.10.02"],
      ["snapMonday", snapMonday("2026-06-14"), "2026-06-08"],
      ["hotfixColorsDistinct", String(hfColors["1.12.01"] !== hfColors["1.12.02"] && hfColors["1.12.01"] !== hfColors["1.12.00"]), "true"],
      ["syncChainSourceNext", syncData.branches[0].sourceNext, "1.13.50"],
      ["syncChainRecvVersion", syncData.branches[1].version, "1.13.50"],
      ["renameBranchNext", rnData.branches[0].sourceNext, "1.13.00"],
      ["renamePatch", rnData.patches[0].version, "1.13.00"],
      ["renameColorMoved", rnData.versionColors["1.13.00"] || "", "#DCEDC8"],
    ];
    for (const [name, got, want] of unit) {
      const ok = got === want;
      if (!ok) pass = false;
      lines.push(`${name}: ${ok ? "PASS" : `FAIL (got ${got}, want ${want})`}`);
    }
    lines.push("warnings: " + JSON.stringify(warnings));
    lines.push(pass ? "SELFTEST: ALL PASS" : "SELFTEST: FAIL");
    const pre = document.createElement("pre");
    pre.id = "selftest"; pre.textContent = lines.join("\n");
    document.body.prepend(pre);
  }

  /* ── 데모 훅 (스크린샷/수동 확인용): ?demo=bridge / ?demo=patch ── */
  render();
  if (location.search.includes("demo=bridge")) {
    document.body.classList.add("editing");
    const td = document.querySelector("td[data-bridge-new]");
    if (td) popBridgeNew(td);
  }
  if (location.search.includes("demo=patch")) {
    document.body.classList.add("editing");
    const td = document.querySelector("td[data-patch-new]");
    if (td) inlinePatchInput(td);
  }
})();
