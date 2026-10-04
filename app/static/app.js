/* 无线话筒频点协调台 —— 原生 JS 前端
 *
 * 结果归属规则（只展示属于“当前方案当前输入”的结果）：
 *   - state.viewId       方案视图代号：新建 / 打开另一方案时递增；
 *   - state.inputVersion 输入版本号：任何影响求解的输入变动时递增；
 *   - 每次 /api/solve 携带发起时的 viewId / inputVersion / seq，响应回来后
 *     三者必须仍与当前状态一致才允许呈现，否则一律静默丢弃（成功不重现、
 *     失败不报错）；进行中的过期请求用 AbortController 主动中止；
 *   - 输入变动立即递增版本号、中止在途请求并撤下结果表格与频谱；
 *   - 保存方案不改动输入版本号，未改输入的保存不会撤下有效结果。
 */
"use strict";

const state = {
  planId: null,
  viewId: 0, // 新建/打开方案时递增
  inputVersion: 0, // 影响求解的输入每次变动递增
  result: null, // { viewId, inputVersion, data }
  solveSeq: 0, // 已发起的求解请求序号
  solveAbort: null, // 当前在途请求的 AbortController
  planMenuOpen: false,
};

const $ = (sel) => document.querySelector(sel);

function toast(msg, isErr = false) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "show" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = ""), 2600);
}

// --------------------------- 方案数据 ---------------------------

function defaultPlan() {
  return {
    name: "",
    minGap: 5,
    imTolerance: 0,
    timeLimit: 10,
    forbidden: [],
    mics: [blankMic("A"), blankMic("B")],
  };
}

function blankMic(id) {
  return { id, candidates: [], current: null, locked: false };
}

let plan = defaultPlan();

// --------------------------- 结果归属管理 ---------------------------

function abortPendingSolve() {
  if (state.solveAbort) {
    state.solveAbort.abort();
    state.solveAbort = null;
  }
}

function hideResultPanel() {
  $("#resultPanel").hidden = true;
  $("#statusBanner").className = "banner";
  $("#statusBanner").innerHTML = "";
  $("#conflicts").innerHTML = "";
  $("#resultSummary").innerHTML = "";
  $("#resultTable").innerHTML = "";
  $("#phaseLog").textContent = "";
  const cv = $("#spectrum");
  cv.style.height = "";
  cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
}

/**
 * 切换方案视图（新建 / 打开另一方案）：旧视图的在途求解即刻过期，
 * 旧结果立即撤下，任何迟到响应都无法再回填本页面。
 */
function beginView() {
  state.viewId += 1;
  state.inputVersion = 0;
  state.result = null;
  abortPendingSolve();
  hideResultPanel();
}

/**
 * 影响求解的输入发生变动：旧结果对当前输入失效，立即撤下表格与频谱，
 * 并中止在途求解（其成功/失败响应随后静默丢弃）。
 */
function noteInputChanged() {
  state.inputVersion += 1;
  state.result = null;
  abortPendingSolve();
  hideResultPanel();
}

/** 仅当结果属于当前方案视图、且属于当前输入版本时才有效。 */
function currentResult() {
  const r = state.result;
  if (
    r &&
    r.viewId === state.viewId &&
    r.inputVersion === state.inputVersion
  ) {
    return r.data;
  }
  return null;
}

// --------------------------- 渲染：话筒卡片 ---------------------------

function renderMics() {
  const wrap = $("#mics");
  wrap.innerHTML = "";
  plan.mics.forEach((mic, idx) => {
    const card = document.createElement("div");
    card.className = "mic-card";
    card.innerHTML = `
      <div class="mic-head">
        <input class="id-input" data-k="id" value="${escapeHtml(mic.id)}"
               maxlength="10" title="设备 ID">
        <label class="lock-wrap">
          <input type="checkbox" data-k="locked" ${mic.locked ? "checked" : ""}>
          🔒 锁定
        </label>
        <span class="spacer"></span>
        <button class="btn btn-small btn-danger" data-act="del"
                ${plan.mics.length <= 2 ? "disabled" : ""}>删除</button>
      </div>
      <div class="mic-field">
        <div class="cap">候选频点（1～12 个互异正整数 kHz，用空格/逗号分隔）
          <span class="cand-count">${mic.candidates.length}/12</span>
        </div>
        <textarea class="cand-area" data-k="candidates" rows="2"
          placeholder="例如：520 530 540 550">${mic.candidates.join(", ")}</textarea>
      </div>
      <div class="mic-field">
        <div class="cap">现用频点（可选，须在候选中）</div>
        <div class="current-row">
          <select data-k="current">
            <option value="">— 无 —</option>
            ${[...mic.candidates]
              .sort((a, b) => a - b)
              .map(
                (f) =>
                  `<option value="${f}" ${mic.current === f ? "selected" : ""}>${f} kHz</option>`
              )
              .join("")}
          </select>
        </div>
      </div>`;

    card.querySelector('[data-k="id"]').addEventListener("input", (e) => {
      mic.id = e.target.value.trim();
      noteInputChanged();
    });

    card.querySelector('[data-k="locked"]').addEventListener("change", (e) => {
      mic.locked = e.target.checked;
      if (mic.locked && mic.current == null && mic.candidates.length) {
        // 锁定必须有现用频点：默认取最小候选
        mic.current = Math.min(...mic.candidates);
        renderMics();
      }
      noteInputChanged();
    });

    const candArea = card.querySelector('[data-k="candidates"]');
    // 敲入即刻令旧结果失效；失焦时完成解析与卡片重建
    candArea.addEventListener("input", noteInputChanged);
    candArea.addEventListener("change", () => {
      const parsed = parseCandidates(candArea.value);
      mic.candidates = parsed.values;
      if (mic.current != null && !mic.candidates.includes(mic.current)) {
        mic.current = null;
      }
      renderMics();
      noteInputChanged();
    });

    card.querySelector('[data-k="current"]').addEventListener("change", (e) => {
      mic.current = e.target.value === "" ? null : parseInt(e.target.value, 10);
      noteInputChanged();
    });

    card.querySelector('[data-act="del"]').addEventListener("click", () => {
      if (plan.mics.length <= 2) return;
      plan.mics.splice(idx, 1);
      renderMics();
      noteInputChanged();
    });

    wrap.appendChild(card);
  });
}

function parseCandidates(text) {
  const parts = text.split(/[\s,，、;；]+/).filter(Boolean);
  const values = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0 && !values.includes(n)) values.push(n);
  }
  return { values, rawCount: parts.length };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// --------------------------- 渲染：禁用区间 ---------------------------

function renderBands() {
  const wrap = $("#bands");
  wrap.innerHTML = "";
  plan.forbidden.forEach((b, idx) => {
    const chip = document.createElement("span");
    chip.className = "band-chip";
    chip.innerHTML = `
      <input type="number" min="1" step="1" value="${b.low}" title="下限（含）">
      <span>～</span>
      <input type="number" min="1" step="1" value="${b.high}" title="上限（含）">
      <span>kHz</span>
      <button class="btn btn-small btn-danger" data-act="delband">×</button>`;
    const [lo, hi] = chip.querySelectorAll("input");
    lo.addEventListener("input", noteInputChanged);
    lo.addEventListener("change", () => {
      plan.forbidden[idx].low = parseInt(lo.value, 10);
      noteInputChanged();
    });
    hi.addEventListener("input", noteInputChanged);
    hi.addEventListener("change", () => {
      plan.forbidden[idx].high = parseInt(hi.value, 10);
      noteInputChanged();
    });
    chip.querySelector('[data-act="delband"]').addEventListener("click", () => {
      plan.forbidden.splice(idx, 1);
      renderBands();
      noteInputChanged();
    });
    wrap.appendChild(chip);
  });
}

// --------------------------- 参数读取与校验 ---------------------------

function collectPlan() {
  plan.name = $("#planName").value.trim();
  plan.minGap = parseInt($("#minGap").value, 10);
  plan.imTolerance = parseInt($("#imTolerance").value, 10);
  plan.timeLimit = parseInt($("#timeLimit").value, 10);
  return plan;
}

function validatePlan(p) {
  const errs = [];
  if (!p.name) errs.push("请填写方案名称");
  if (!Number.isInteger(p.minGap) || p.minGap < 1)
    errs.push("最小频差 d 须为正整数");
  if (!Number.isInteger(p.imTolerance) || p.imTolerance < 0)
    errs.push("互调容差 g 须为非负整数");
  if (!Number.isInteger(p.timeLimit) || p.timeLimit < 1)
    errs.push("求解时限须为正整数秒");

  for (const [i, b] of p.forbidden.entries()) {
    if (!Number.isInteger(b.low) || !Number.isInteger(b.high) || b.low < 1)
      errs.push(`禁用区间 #${i + 1} 频点须为正整数`);
    else if (b.low > b.high)
      errs.push(`禁用区间 #${i + 1} 下限（${b.low}）不能大于上限（${b.high}）`);
  }

  if (p.mics.length < 2 || p.mics.length > 8)
    errs.push("话筒数量须在 2～8 支之间");

  const ids = p.mics.map((m) => m.id);
  if (ids.some((id) => !id)) errs.push("每支话筒都必须填写设备 ID");
  if (new Set(ids).size !== ids.length) errs.push("设备 ID 不得重复");

  for (const m of p.mics) {
    if (m.candidates.length < 1 || m.candidates.length > 12)
      errs.push(`设备 ${m.id || "?"} 候选频点须为 1～12 个互异正整数 kHz`);
    if (m.current != null && !m.candidates.includes(m.current))
      errs.push(`设备 ${m.id} 的现用频点 ${m.current} kHz 不在候选频点中`);
    if (m.locked && m.current == null)
      errs.push(`锁定设备 ${m.id} 必须填写现用频点`);
  }
  return errs;
}

// --------------------------- 求解 ---------------------------

async function solvePlan() {
  collectPlan();
  const errs = validatePlan(plan);
  if (errs.length) {
    toast(errs[0] + (errs.length > 1 ? ` 等 ${errs.length} 项错误` : ""), true);
    return;
  }

  // 发起前先中止任何残留的在途请求（正常情况下按钮禁用，并无并发）
  abortPendingSolve();

  // 记录本次请求的归属：只有三者始终未变，响应才允许呈现
  const viewId = state.viewId;
  const inputVersion = state.inputVersion;
  const seq = ++state.solveSeq;
  const controller = new AbortController();
  state.solveAbort = controller;

  const btn = $("#btnSolve");
  btn.disabled = true;
  btn.textContent = "求解中…";

  const isStale = () =>
    state.viewId !== viewId ||
    state.inputVersion !== inputVersion ||
    state.solveSeq !== seq;

  try {
    const resp = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toApiPayload(plan)),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({}));
      throw new Error(detail.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    // 过期成功响应：静默丢弃，不得回填当前页面
    if (isStale()) return;
    state.result = { viewId, inputVersion, data };
    renderResult(data);
  } catch (e) {
    // 被中止或已过期的失败响应：静默丢弃，不弹错误
    if (e.name === "AbortError" || isStale()) return;
    toast("求解失败：" + e.message, true);
  } finally {
    // 仅最新一次请求有权恢复按钮，避免旧请求提前解锁
    if (state.solveSeq === seq) {
      state.solveAbort = null;
      btn.disabled = false;
      btn.textContent = "▶ 协调求解";
    }
  }
}

function toApiPayload(p) {
  return {
    name: p.name,
    minGap: p.minGap,
    imTolerance: p.imTolerance,
    timeLimit: p.timeLimit,
    forbidden: p.forbidden.map((b) => ({ low: b.low, high: b.high })),
    mics: p.mics.map((m) => ({
      id: m.id,
      candidates: [...m.candidates].sort((a, b) => a - b),
      current: m.current,
      locked: m.locked,
    })),
  };
}

// --------------------------- 结果渲染 ---------------------------

function renderResult(r) {
  const panel = $("#resultPanel");
  panel.hidden = false;

  const banner = $("#statusBanner");
  const conflictBox = $("#conflicts");
  const summary = $("#resultSummary");
  conflictBox.innerHTML = "";
  summary.innerHTML = "";

  if (r.status === "conflict") {
    banner.className = "banner conflict";
    banner.innerHTML =
      '<span class="big">⛔ 锁定集合冲突</span>' +
      "锁定设备必须保留现用频点，下列规则无法同时满足，未进行分配求解。";
    conflictBox.innerHTML = r.conflicts
      .map(
        (c) => `
      <div class="conflict-item">
        <span class="tag">${escapeHtml(c.rule)}</span>
        <span class="devs">[${c.devices.map(escapeHtml).join(", ")}]</span>
        <div>${escapeHtml(c.detail)}</div>
      </div>`
      )
      .join("");
    $("#resultTable").innerHTML = "";
    $("#phaseLog").textContent = "";
    clearCanvas();
    panel.scrollIntoView({ behavior: "smooth" });
    return;
  }

  if (r.optimal) {
    banner.className = "banner optimal";
    banner.innerHTML =
      '<span class="big">✅ 已证最优</span>' +
      `在 ${r.solveTimeMs} ms 内证明该方案满足全部优先级最优。`;
  } else {
    banner.className = "banner feasible";
    banner.innerHTML =
      '<span class="big">⚠️ 可行解（未证最优）</span>' +
      `已在求解时限（${r.timeLimitSec} 秒）内找到可行解，但未能证明其最优性；` +
      `可尝试延长求解时限。实际用时 ${r.solveTimeMs} ms。`;
  }

  summary.innerHTML = `
    <span>已分配 <b>${r.assignedCount}</b> / ${r.assignment.length} 支</span>
    <span>现用频点变更 <b>${r.changeCount}</b> 台</span>
    <span>最小频差 d = <b>${plan.minGap}</b> kHz</span>
    <span>互调容差 g = <b>${plan.imTolerance}</b> kHz</span>`;

  // 表格
  const rows = r.assignment
    .map(
      (a) => `
    <tr class="${a.assigned ? "assigned" : "unassigned"}">
      <td>${escapeHtml(a.id)} ${a.locked ? '<span class="locked-mark">🔒</span>' : ""}</td>
      <td>${a.current == null ? "—" : a.current + " kHz"}</td>
      <td class="freq-cell">${a.assigned ? a.frequency + " kHz" : "<i>未分配</i>"}</td>
      <td>${a.changed ? '<span class="changed-mark">✔ 变更</span>' : "—"}</td>
      <td>${a.assigned ? "✔" : "—"}</td>
    </tr>`
    )
    .join("");
  $("#resultTable").innerHTML = `
    <table>
      <thead><tr>
        <th>设备 ID</th><th>现用频点</th><th>协调频点</th><th>是否变更</th><th>已分配</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  $("#phaseLog").textContent = r.phases
    .map((p) => `[阶段${p.order}] ${p.phase}  →  ${p.status}${p.objective != null ? "  (目标值 " + p.objective + ")" : ""}`)
    .join("\n");

  drawSpectrum(plan, r);
  panel.scrollIntoView({ behavior: "smooth" });
}

// --------------------------- 频谱绘制 ---------------------------

function clearCanvas() {
  const cv = $("#spectrum");
  cv.style.height = "";
  cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
}

function drawSpectrum(p, r) {
  const cv = $("#spectrum");
  const ctx = cv.getContext("2d");

  // 高分屏适配
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 1100;
  const rowH = 34;
  const cssH = Math.max(200, 90 + r.assignment.length * rowH + 40);
  cv.style.height = cssH + "px";
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const padL = 80, padR = 30, padT = 34, padB = 34;

  const allFreqs = p.mics.flatMap((m) => m.candidates);
  let fMin = Math.min(...allFreqs);
  let fMax = Math.max(...allFreqs);
  const span = Math.max(1, fMax - fMin);
  fMin -= span * 0.05 + 2;
  fMax += span * 0.05 + 2;

  const xOf = (f) => padL + ((f - fMin) / (fMax - fMin)) * (W - padL - padR);
  const plotW = W - padL - padR;

  ctx.clearRect(0, 0, W, cssH);

  // 禁用闭区间
  for (const b of p.forbidden) {
    const x1 = xOf(Math.max(b.low, fMin));
    const x2 = xOf(Math.min(b.high, fMax));
    if (x2 < padL || x1 > W - padR) continue;
    ctx.fillStyle = "rgba(255,90,90,0.16)";
    ctx.fillRect(x1, padT - 8, x2 - x1, cssH - padT - padB + 16);
    ctx.strokeStyle = "rgba(255,90,90,0.55)";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x1, padT - 8, x2 - x1, cssH - padT - padB + 16);
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,120,120,0.9)";
    ctx.font = "10px sans-serif";
    ctx.fillText(`禁用 ${b.low}~${b.high}`, x1 + 4, padT + 4);
  }

  // 坐标轴与网格
  const gridStep = niceStep((fMax - fMin) / 8);
  ctx.strokeStyle = "rgba(147,161,184,0.18)";
  ctx.fillStyle = "#93a1b8";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  const startTick = Math.ceil(fMin / gridStep) * gridStep;
  for (let f = startTick; f <= fMax; f += gridStep) {
    const x = xOf(f);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, cssH - padB);
    ctx.stroke();
    ctx.fillText(f + "", x, cssH - padB + 16);
  }
  ctx.textAlign = "left";
  ctx.fillText("频率 / kHz", padL, cssH - 6);

  // 图例
  const legend = [
    ["#7d8ca3", "候选"],
    ["#4f9cff", "现用"],
    ["#34c79a", "已分配"],
    ["#b48cff", "锁定"],
  ];
  let lx = W - padR - 220;
  legend.forEach(([color, name]) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx, 16, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c6d2e4";
    ctx.font = "11px sans-serif";
    ctx.fillText(name, lx + 9, 20);
    lx += 58;
  });

  // 每支话筒一行
  const byId = Object.fromEntries(r.assignment.map((a) => [a.id, a]));
  p.mics.forEach((mic, i) => {
    const y = padT + 14 + i * rowH;
    const a = byId[mic.id];

    ctx.strokeStyle = "rgba(147,161,184,0.25)";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();

    ctx.fillStyle = "#c6d2e4";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(mic.id + (mic.locked ? " 🔒" : ""), padL - 8, y + 4);
    ctx.textAlign = "center";

    // 候选刻度
    ctx.strokeStyle = "#7d8ca3";
    ctx.lineWidth = 1.5;
    for (const f of mic.candidates) {
      const x = xOf(f);
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x, y + 6);
      ctx.stroke();
    }

    // 现用：蓝色空心三角
    if (mic.current != null) {
      const x = xOf(mic.current);
      ctx.strokeStyle = "#4f9cff";
      ctx.fillStyle = "rgba(79,156,255,0.25)";
      ctx.beginPath();
      ctx.moveTo(x, y - 9);
      ctx.lineTo(x - 6, y + 4);
      ctx.lineTo(x + 6, y + 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // 已分配：大圆点 + 频点标注
    if (a && a.assigned) {
      const x = xOf(a.frequency);
      ctx.fillStyle = a.locked ? "#b48cff" : "#34c79a";
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0d1524";
      ctx.font = "bold 9px sans-serif";
      ctx.fillText(a.locked ? "L" : "✓", x, y + 3);
      ctx.fillStyle = a.locked ? "#d8c4ff" : "#8ff0d2";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(a.frequency + "", x, y - 12);
    } else {
      ctx.fillStyle = "#8a7a55";
      ctx.font = "11px sans-serif";
      ctx.fillText("未分配", W - padR - 30, y + 4);
    }
  });
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  let f;
  if (n < 1.5) f = 1;
  else if (n < 3.5) f = 2;
  else if (n < 7.5) f = 5;
  else f = 10;
  return f * pow;
}

// --------------------------- 保存 / 打开 ---------------------------

async function savePlan() {
  collectPlan();
  const errs = validatePlan(plan);
  if (errs.length) {
    toast(errs[0] + (errs.length > 1 ? ` 等 ${errs.length} 项错误` : ""), true);
    return;
  }
  const payload = toApiPayload(plan);
  // 保存不触碰 inputVersion / state.result：输入未变时有效结果原样保留
  try {
    let resp;
    if (state.planId) {
      resp = await fetch(`/api/plans/${state.planId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      resp = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.detail || `HTTP ${resp.status}`);
    }
    const saved = await resp.json();
    state.planId = saved.id;
    $("#planName").value = saved.name;
    toast(`方案「${saved.name}」已保存（#${saved.id}）`);
  } catch (e) {
    toast("保存失败：" + e.message, true);
  }
}

async function renderPlanMenu() {
  const menu = $("#planMenu");
  try {
    const resp = await fetch("/api/plans");
    const plans = await resp.json();
    menu.innerHTML = "";
    if (!plans.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "（暂无已保存方案）";
      menu.appendChild(li);
    } else {
      for (const p of plans) {
        const li = document.createElement("li");
        li.innerHTML = `
          <span class="pname">${escapeHtml(p.name)}
            <div class="pmeta">#${p.id}　更新于 ${escapeHtml(p.updatedAt)}</div>
          </span>
          <button class="del" title="删除">🗑</button>`;
        li.querySelector(".pname").addEventListener("click", () => loadPlan(p.id));
        li.querySelector(".del").addEventListener("click", (e) => {
          e.stopPropagation();
          deletePlan(p.id);
        });
        menu.appendChild(li);
      }
    }
  } catch (e) {
    toast("读取方案列表失败：" + e.message, true);
  }
}

async function togglePlanMenu() {
  const menu = $("#planMenu");
  if (state.planMenuOpen) {
    menu.hidden = true;
    state.planMenuOpen = false;
    return;
  }
  await renderPlanMenu();
  menu.hidden = false;
  state.planMenuOpen = true;
}

async function loadPlan(id) {
  // 立即切换归属：在途求解与旧结果即刻失效，迟到响应无法回填
  const viewId = state.viewId + 1;
  state.viewId = viewId;
  state.inputVersion = 0;
  state.result = null;
  abortPendingSolve();
  hideResultPanel();
  const menu = $("#planMenu");
  menu.hidden = true;
  state.planMenuOpen = false;

  try {
    const resp = await fetch(`/api/plans/${id}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const rec = await resp.json();
    if (state.viewId !== viewId) return; // 期间又新建/打开了别的方案
    const d = rec.plan;
    plan = {
      name: d.name,
      minGap: d.minGap,
      imTolerance: d.imTolerance,
      timeLimit: d.timeLimit,
      forbidden: d.forbidden.map((b) => ({ ...b })),
      mics: d.mics.map((m) => ({
        id: m.id,
        candidates: [...m.candidates],
        current: m.current,
        locked: m.locked,
      })),
    };
    state.planId = rec.id;
    syncFormFromPlan();
    toast(`已打开方案「${rec.name}」`);
  } catch (e) {
    if (state.viewId !== viewId) return;
    toast("打开失败：" + e.message, true);
  }
}

async function deletePlan(id) {
  if (!confirm(`确认删除方案 #${id}？`)) return;
  const resp = await fetch(`/api/plans/${id}`, { method: "DELETE" });
  if (!resp.ok) {
    toast("删除失败", true);
    return;
  }
  if (state.planId === id) newPlan(false);
  await refreshPlanMenu();
  toast("方案已删除");
}

async function refreshPlanMenu() {
  if (state.planMenuOpen) await renderPlanMenu();
}

function syncFormFromPlan() {
  $("#planName").value = plan.name;
  $("#minGap").value = plan.minGap;
  $("#imTolerance").value = plan.imTolerance;
  $("#timeLimit").value = plan.timeLimit;
  renderBands();
  renderMics();
}

function newPlan(confirmFlag = true) {
  if (confirmFlag && !confirm("新建将清空当前未保存的编辑，确定？")) return;
  beginView();
  plan = defaultPlan();
  state.planId = null;
  syncFormFromPlan();
}

// --------------------------- 初始化 ---------------------------

function init() {
  renderBands();
  renderMics();

  // 全局参数变动：同步数值并立即令旧结果失效（方案名称不影响求解，不纳入）
  const onGlobalInput = () => {
    collectPlan();
    noteInputChanged();
  };
  $("#minGap").addEventListener("input", onGlobalInput);
  $("#imTolerance").addEventListener("input", onGlobalInput);
  $("#timeLimit").addEventListener("input", onGlobalInput);

  $("#btnAddBand").addEventListener("click", () => {
    collectPlan();
    const base = plan.forbidden.length
      ? plan.forbidden[plan.forbidden.length - 1].high + 1
      : 500;
    plan.forbidden.push({ low: base, high: base + 10 });
    renderBands();
    noteInputChanged();
  });
  $("#btnAddMic").addEventListener("click", () => {
    collectPlan();
    if (plan.mics.length >= 8) {
      toast("最多支持 8 支话筒", true);
      return;
    }
    const used = new Set(plan.mics.map((m) => m.id));
    let id = "A";
    for (let i = 0; used.has(id); i++) {
      id = String.fromCharCode(65 + ((i + 1) % 26)) + (i >= 25 ? i + 1 : "");
    }
    plan.mics.push(blankMic(id));
    renderMics();
    noteInputChanged();
  });
  $("#btnSolve").addEventListener("click", solvePlan);
  $("#btnSave").addEventListener("click", savePlan);
  $("#btnOpen").addEventListener("click", togglePlanMenu);
  $("#btnNew").addEventListener("click", () => newPlan(true));
  document.addEventListener("click", (e) => {
    if (state.planMenuOpen &&
        !$("#planMenu").contains(e.target) &&
        e.target !== $("#btnOpen")) {
      $("#planMenu").hidden = true;
      state.planMenuOpen = false;
    }
  });
  // 仅在结果仍属于当前方案当前输入、且面板可见时重绘，
  // 绝不让新输入与旧解同屏；冲突结果无分配数据，不绘制频谱
  window.addEventListener("resize", () => {
    if ($("#resultPanel").hidden) return;
    const r = currentResult();
    if (r && r.status !== "conflict") drawSpectrum(plan, r);
  });
}

init();
