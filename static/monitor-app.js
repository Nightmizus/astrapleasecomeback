"use strict";

const byId = (id) => document.getElementById(id);

const STATUS_LABELS = { ok: "正常", wrong_model: "归因异常", invalid: "数字不足", error: "失败" };
const TRIGGER_LABELS = { scheduled: "定时", manual: "手动", startup: "启动补跑" };

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(iso) {
  if (!iso) return "—";
  return timeFormatter.format(new Date(iso));
}

function escapeText(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let pollTimer = null;

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  if (!pollTimer) pollTimer = window.setInterval(refresh, 5000);
}

function squareTitle(record) {
  const lines = [
    `${formatTime(record.started_at)}（${TRIGGER_LABELS[record.trigger] || record.trigger}）`,
    `状态：${STATUS_LABELS[record.status] || record.status}`,
    `归因：${record.attributed || "—"}${record.probability != null ? ` · ${(record.probability * 100).toFixed(1)}%` : ""}`,
    `有效数字：${record.parsed_numbers ?? 0} / 阈值 ${record.minimum_numbers ?? 0}`,
    `耗时：${record.duration_seconds != null ? `${record.duration_seconds} 秒` : "—"}`,
  ];
  if (record.error) lines.push(record.error);
  return lines.join("\n");
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function shanghaiDay(date) {
  return dayFormatter.format(date); // YYYY-MM-DD（东八区）
}

function addDays(dayStr, n) {
  const d = new Date(`${dayStr}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return shanghaiDay(d);
}

function recordDayHour(record) {
  const iso = record.started_at || "";
  if (iso.length < 13) return null;
  const hour = parseInt(iso.slice(11, 13), 10);
  if (Number.isNaN(hour)) return null;
  return { day: iso.slice(0, 10), hour };
}

function renderGrid(records) {
  const grid = byId("heat-grid");
  const wrap = byId("heat-wrap");
  const SCHEDULED_HOURS = new Set([7, 12, 17]);
  const MIN_DAYS = 14;
  const MAX_DAYS = 62;

  const buckets = new Map();
  let earliest = null;
  for (const record of records) {
    const dh = recordDayHour(record);
    if (!dh) continue;
    if (!earliest || dh.day < earliest) earliest = dh.day;
    const key = `${dh.day}|${dh.hour}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }

  const today = shanghaiDay(new Date());
  let startDay = addDays(today, -(MIN_DAYS - 1));
  if (earliest && earliest < startDay) {
    startDay = earliest;
    // 限制最多 MAX_DAYS 列
    while (addDays(startDay, MAX_DAYS - 1) < today) startDay = addDays(startDay, 1);
  }

  const days = [];
  for (let d = startDay; ; d = addDays(d, 1)) {
    days.push(d);
    if (d >= today) break;
  }
  const cells = [];
  cells.push(`<span class="hg-corner"></span>`);
  for (const d of days) {
    cells.push(`<span class="hg-col-label${d === today ? " today" : ""}">${d.slice(5)}</span>`);
  }
  for (let hour = 0; hour < 24; hour += 1) {
    cells.push(`<span class="hg-hour">${hour}</span>`);
    for (const d of days) {
      const list = buckets.get(`${d}|${hour}`) || [];
      const slot = SCHEDULED_HOURS.has(hour) ? " slot" : "";
      if (list.length === 0) {
        cells.push(`<span class="hg-cell${slot}"></span>`);
        continue;
      }
      const minis = list
        .map((r) => `<i class="hg-mini ${r.status === "ok" ? "ok" : "bad"}"></i>`)
        .join("");
      const title = list.map(squareTitle).join("\n────────\n");
      cells.push(
        `<span class="hg-cell${slot}" data-has="1" title="${escapeText(title).replace(/\n/g, "&#10;").replace(/"/g, "&quot;")}">${minis}</span>`,
      );
    }
  }

  grid.style.setProperty("--cols", String(days.length));
  grid.innerHTML = cells.join("");
  wrap.scrollLeft = wrap.scrollWidth; // 滚到最右（今天）
}

function render(data) {
  const records = data.records || [];
  const latest = records[records.length - 1];
  const latestEl = byId("stat-latest");
  if (!latest) {
    latestEl.textContent = "暂无记录";
    latestEl.className = "";
  } else if (latest.status === "ok") {
    latestEl.textContent = `正常 · ${formatTime(latest.started_at)}`;
    latestEl.className = "good";
  } else {
    latestEl.textContent = `${STATUS_LABELS[latest.status] || latest.status} · ${formatTime(latest.started_at)}`;
    latestEl.className = "bad";
  }
  byId("stat-next").textContent = data.next_run_at ? formatTime(data.next_run_at) : "—";
  byId("stat-total").textContent = data.total ? `${data.total} 次` : "—";
  byId("stat-rate").textContent = data.total ? `${Math.round((data.ok_count / data.total) * 100)}%` : "—";

  renderGrid(records);
  byId("empty-hint").hidden = records.length > 0;

  const anomalies = records.filter((record) => record.status !== "ok").slice(-10).reverse();
  byId("anomaly-body").innerHTML = anomalies
    .map((record) => {
      const stateClass = record.status === "ok" ? "" : "state-bad";
      return `<tr>
        <td>${formatTime(record.started_at)}</td>
        <td>${escapeText(TRIGGER_LABELS[record.trigger] || record.trigger)}</td>
        <td class="${stateClass}">${escapeText(STATUS_LABELS[record.status] || record.status)}</td>
        <td>${escapeText(record.attributed || "—")}</td>
        <td>${record.probability != null ? `${(record.probability * 100).toFixed(1)}%` : "—"}</td>
        <td>${record.parsed_numbers ?? 0}/${record.minimum_numbers ?? 0}</td>
        <td>${record.duration_seconds != null ? `${record.duration_seconds}s` : "—"}</td>
        <td class="note">${escapeText(record.error || "—")}</td>
      </tr>`;
    })
    .join("");
  byId("no-anomaly").hidden = anomalies.length > 0;

  byId("run-now").disabled = data.running;
  if (data.running) {
    byId("run-message").className = "run-message";
    byId("run-message").textContent = "检测进行中：正在等待 Codex 会话与指纹归因（约 1-3 分钟）……";
    startPolling();
  } else if (pollTimer) {
    stopPolling();
    byId("run-message").textContent = "";
  }
}

async function refresh() {
  try {
    const response = await fetch("/api/monitor/history");
    render(await response.json());
  } catch (error) {
    byId("run-message").className = "run-message error";
    byId("run-message").textContent = `加载失败：${error.message}`;
  }
}

byId("run-now").addEventListener("click", async () => {
  const message = byId("run-message");
  try {
    const response = await fetch("/api/monitor/run", { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "启动失败");
    message.className = "run-message";
    message.textContent = "检测已启动，正在等待结果……";
    byId("run-now").disabled = true;
    startPolling();
  } catch (error) {
    message.className = "run-message error";
    message.textContent = error.message;
  }
});

refresh();
window.setInterval(refresh, 60000);
