const state = {
  challenges: [],
  bankId: window.DEFAULT_BANK_ID,
  bank: window.BANK_SUMMARIES[window.DEFAULT_BANK_ID],
  unified: window.UNIFIED_SUMMARY,
};

const byId = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function optionalNumber(id) {
  const value = byId(id).value.trim();
  return value === "" ? null : Number(value);
}

function setMessage(element, text, type = "error") {
  element.textContent = text;
  element.className = `message ${type}`;
  element.hidden = !text;
}

function activateWorkspace(name) {
  document.querySelectorAll(".workspace").forEach((item) => item.classList.toggle("active", item.id === `workspace-${name}`));
  document.querySelectorAll("[data-workspace]").forEach((item) => item.classList.toggle("active", item.dataset.workspace === name));
}

function activateMode(group, name) {
  document.querySelectorAll(`[data-${group}-mode]`).forEach((item) => item.classList.toggle("active", item.dataset[`${group}Mode`] === name));
  document.querySelectorAll(`#workspace-${group === "test" ? "test" : "library"} .mode-panel`).forEach((item) => {
    item.classList.toggle("active", item.id === `${group}-${name}` || item.id === `library-${name}`);
  });
}

async function loadChallenges() {
  byId("regenerate").disabled = true;
  byId("result").hidden = true;
  setMessage(byId("test-message"), "");
  const response = await fetch("/api/challenges");
  state.challenges = (await response.json()).challenges;
  renderChallenges();
  byId("regenerate").disabled = false;
}

function renderChallenges() {
  byId("challenge-list").innerHTML = state.challenges.map((challenge, index) => `
    <article class="challenge-item">
      <div class="challenge-header">
        <strong>挑战 ${index + 1}</strong>
        <span>${challenge.expected_count} 个数字</span>
        <button type="button" data-copy="${index}">复制提示词</button>
      </div>
      <div class="challenge-columns">
        <div><label>发送给待测模型</label><pre>${escapeHtml(challenge.prompt)}</pre></div>
        <div><label for="output-${index}">粘贴完整输出</label><textarea id="output-${index}" spellcheck="false" placeholder="保留文字、标点、代码块和完整数字序列"></textarea></div>
      </div>
    </article>
  `).join("");
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(state.challenges[Number(button.dataset.copy)].prompt);
      button.textContent = "已复制";
      window.setTimeout(() => { button.textContent = "复制提示词"; }, 1000);
    });
  });
}

function renderResult(payload) {
  const diagnostics = payload.diagnostics.map((item, index) => `
    <span class="diagnostic ${item.accepted ? "accepted" : "rejected"}">挑战 ${index + 1}: ${item.parsed_numbers} 个数字 · ${item.accepted ? "计入" : "忽略"}</span>
  `).join("");
  const rows = payload.results.map((item, index) => `
    <tr class="${index === 0 ? "winner" : ""}">
      <td>${index + 1}</td><td><strong>${escapeHtml(item.display_name)}</strong></td><td>${escapeHtml(item.family_name)}</td>
      <td><div class="probability-cell"><span><i style="width:${item.probability * 100}%"></i></span><strong>${percent(item.probability)}</strong></div></td>
      <td>${percent(item.profile_similarity)}</td>
    </tr>
  `).join("");
  const apiNote = payload.api_test
    ? `<span>API 获得 ${payload.api_test.received}/${payload.api_test.requested} 份有效回答，实际尝试 ${payload.api_test.attempted}/${payload.api_test.max_attempts}${payload.api_test.errors.length ? `，${payload.api_test.errors.length} 次未采用` : ""}</span>`
    : "";
  const cliNote = payload.cli_test
    ? `<span>${escapeHtml(payload.cli_test.tool)} 一键检测：模型 ${escapeHtml(payload.cli_test.model)} · 获得 ${payload.cli_test.received}/${payload.cli_test.requested} 份有效回答 · 临时会话已清理</span>`
    : "";
  byId("result").innerHTML = `
    <div class="result-summary">
      <div><span>最可能模型</span><strong>${escapeHtml(payload.prediction_name)}</strong></div>
      <div><span>统一库概率</span><strong>${percent(payload.probability)}</strong></div>
      <div><span>自动识别家族</span><strong>${escapeHtml(payload.family_prediction_name)} · ${percent(payload.family_probability)}</strong></div>
      <div><span>有效查询</span><strong>${payload.used_outputs}/3</strong></div>
    </div>
    <div class="diagnostics">${diagnostics}</div>
    <div class="table-wrap"><table><thead><tr><th>排序</th><th>候选模型</th><th>家族</th><th>归因概率</th><th>分布相似度</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${apiNote || cliNote ? `<div class="result-note">${apiNote}${cliNote}</div>` : ""}
    <div class="result-guidance" role="note" aria-label="结果说明">
      <p>本工具仅对指纹库内的模型进行归因；若待测模型不在指纹库中，得到任何结果都有可能。</p>
      <p>Claude 家族指纹采集自干净 API 环境；本页 Claude 一键检测已把 Claude Code 默认系统提示词替换为固定前缀以贴近采集条件，结果仍可能带有少量偏差。</p>
    </div>
  `;
  byId("result").hidden = false;
  byId("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function analyzeManual() {
  const button = byId("analyze");
  button.disabled = true;
  setMessage(byId("test-message"), "正在计算……", "working");
  const outputs = state.challenges.map((challenge, index) => ({
    text: byId(`output-${index}`).value,
    expected_count: challenge.expected_count,
  }));
  const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outputs }) });
  const payload = await response.json();
  if (response.ok) {
    setMessage(byId("test-message"), "");
    renderResult(payload);
  } else {
    setMessage(byId("test-message"), payload.error || "无法完成归因。", "error");
    byId("result").hidden = true;
  }
  button.disabled = false;
}

function renderApiProgress(states, status) {
  const valid = states.filter((state) => state === "done").length;
  const attempted = states.filter((state) => ["done", "invalid", "error"].includes(state)).length;
  const target = 3;
  byId("api-test-progress").hidden = false;
  byId("api-progress-status").textContent = status;
  byId("api-progress-count").textContent = `有效 ${valid}/${target} · 已尝试 ${attempted}/${states.length}`;
  byId("api-progress-fill").style.width = `${(valid / target) * 100}%`;
  byId("api-progress-steps").innerHTML = states.map((state, index) => {
    const labels = { pending: "等待", working: "请求中", done: "有效", invalid: "数字不足", error: "接口失败", skipped: "无需调用" };
    return `<span class="progress-step ${state}"><b>${index + 1}</b>挑战 ${index + 1} · ${labels[state]}</span>`;
  }).join("");
}

async function testViaApi(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  byId("result").hidden = true;
  setMessage(byId("test-message"), "");

  const challengeResponse = await fetch("/api/challenges");
  const firstBatch = (await challengeResponse.json()).challenges;
  const retryResponse = await fetch("/api/challenges");
  const challenges = firstBatch.concat((await retryResponse.json()).challenges);
  const states = challenges.map(() => "pending");
  const outputs = [];
  const errors = [];
  const target = 3;
  const configuration = {
    base_url: byId("test-api-base").value,
    api_key: byId("test-api-key").value,
    api_model: byId("test-api-model").value,
    temperature: optionalNumber("test-temperature"),
  };
  renderApiProgress(states, "已生成独立挑战，准备调用模型");

  for (let index = 0; index < challenges.length && outputs.length < target; index += 1) {
    states[index] = "working";
    renderApiProgress(states, `正在进行第 ${index + 1} 次尝试，等待模型完整输出……`);
    try {
      const response = await fetch("/api/test/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...configuration,
          prompt: challenges[index].prompt,
          expected_count: challenges[index].expected_count,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "接口请求失败");
      if (payload.accepted) {
        outputs.push({ text: payload.text, expected_count: challenges[index].expected_count });
        states[index] = "done";
      } else {
        errors.push(`尝试 ${index + 1}: 有效数字 ${payload.parsed_numbers}/${payload.minimum_numbers}`);
        states[index] = "invalid";
      }
    } catch (error) {
      errors.push(`尝试 ${index + 1}: ${error.message}`);
      states[index] = "error";
    }
    renderApiProgress(states, `当前已有 ${outputs.length}/${target} 份有效回答`);
  }

  if (outputs.length === target) {
    states.forEach((state, index) => { if (state === "pending") states[index] = "skipped"; });
  }

  if (!outputs.length) {
    renderApiProgress(states, "六次尝试后仍没有可用回答");
    setMessage(byId("test-message"), `没有获得可分析输出。${errors[0] || ""}`, "error");
    button.disabled = false;
    return;
  }

  renderApiProgress(states, "模型回答已收齐，正在计算归因概率……");
  const analysisResponse = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outputs }),
  });
  const result = await analysisResponse.json();
  if (analysisResponse.ok) {
    const attempted = states.filter((state) => ["done", "invalid", "error"].includes(state)).length;
    result.api_test = { requested: target, attempted, max_attempts: challenges.length, received: outputs.length, errors };
    renderApiProgress(states, `测试完成：${outputs.length}/${target} 份有效回答进入归因`);
    renderResult(result);
  } else {
    setMessage(byId("test-message"), result.error || "API 自动测试失败。", "error");
  }
  button.disabled = false;
}

const oneClickTools = {
  codex: {
    label: "Codex",
    statusUrl: "/api/codex/status",
    probeUrl: "/api/codex/probe",
    status: "codex-status", model: "codex-model", custom: "codex-model-custom", run: "codex-run",
    form: "codex-test-form", panel: "codex-test-progress", heading: "codex-progress-status",
    count: "codex-progress-count", fill: "codex-progress-fill", steps: "codex-progress-steps",
    readyLine: (status, models) => `Codex 就绪：${status.version || "codex-cli"} · 已登录 · 可用模型 ${models.length} 个。检测将开启 3 个独立临时会话，结束后自动删除，不保留对话记录。`,
  },
  claude: {
    label: "Claude",
    statusUrl: "/api/claude/status",
    probeUrl: "/api/claude/probe",
    status: "claude-status", model: "claude-model", custom: "claude-model-custom", run: "claude-run",
    form: "claude-test-form", panel: "claude-test-progress", heading: "claude-progress-status",
    count: "claude-progress-count", fill: "claude-progress-fill", steps: "claude-progress-steps",
    readyLine: (status, models) => `Claude 就绪：${status.version || "claude-cli"} · ${status.auth_status || "已登录"} · 候选模型 ${models.length} 个。检测将开启 3 个独立临时会话（系统提示词替换为固定前缀、禁用工具），结束后自动删除，不保留对话记录。`,
  },
};
const oneClickLoaded = { codex: false, claude: false };

function bankClaudeModels() {
  return ((window.BANK_SUMMARIES.claude || {}).models || []).map((model) => ({ slug: model.id, display_name: model.display_name }));
}

async function loadOneClickStatus(key) {
  const tool = oneClickTools[key];
  const statusLine = byId(tool.status);
  const select = byId(tool.model);
  const button = byId(tool.run);
  statusLine.textContent = `正在检测本机 ${tool.label} 环境……`;
  statusLine.className = "cli-status";
  try {
    const response = await fetch(tool.statusUrl);
    const status = await response.json();
    oneClickLoaded[key] = true;
    if (!status.installed) {
      statusLine.textContent = `未检测到 ${key} 命令：请先安装 ${tool.label} CLI 并重新打开本页。`;
      statusLine.className = "cli-status error";
      return;
    }
    if (!status.logged_in) {
      statusLine.textContent = `${tool.label} CLI ${status.version || ""} 已安装，但未检测到可用凭据（${status.auth_status || status.login_status || "无登录信息"}）。请先完成登录或 API 配置，然后刷新本页。`;
      statusLine.className = "cli-status error";
      return;
    }
    const models = (status.models || []).slice();
    if (key === "claude") {
      for (const model of bankClaudeModels()) {
        if (!models.some((item) => item.slug === model.slug)) models.push(model);
      }
    }
    if (status.default_model && !models.some((item) => item.slug === status.default_model)) {
      models.unshift({ slug: status.default_model, display_name: "CLI 默认模型" });
    }
    if (models.length) {
      select.innerHTML = models.map((model) => `<option value="${escapeHtml(model.slug)}"${model.slug === status.default_model ? " selected" : ""}>${escapeHtml(model.display_name)}（${escapeHtml(model.slug)}）</option>`).join("");
    } else {
      select.innerHTML = `<option value="">请输入自定义模型名</option>`;
    }
    button.disabled = false;
    statusLine.textContent = tool.readyLine(status, models);
    statusLine.className = "cli-status ok";
  } catch (error) {
    statusLine.textContent = `无法获取 ${tool.label} 状态：${error.message}`;
    statusLine.className = "cli-status error";
  }
}

function renderOneClickProgress(key, states, status) {
  const tool = oneClickTools[key];
  const valid = states.filter((state) => state === "done").length;
  const target = 3;
  byId(tool.panel).hidden = false;
  byId(tool.heading).textContent = status;
  byId(tool.count).textContent = `有效 ${valid}/${target}`;
  byId(tool.fill).style.width = `${(valid / target) * 100}%`;
  byId(tool.steps).innerHTML = states.map((state, index) => {
    const labels = { pending: "等待", working: "会话进行中", done: "有效", invalid: "数字不足", error: "失败" };
    return `<span class="progress-step ${state}"><b>${index + 1}</b>会话 ${index + 1} · ${labels[state] || state}</span>`;
  }).join("");
}

async function runOneClickTest(key, event) {
  event.preventDefault();
  const tool = oneClickTools[key];
  const button = event.currentTarget.querySelector("button[type=submit]");
  const customModel = byId(tool.custom).value.trim();
  const model = customModel || byId(tool.model).value;
  if (!model) {
    setMessage(byId("test-message"), `请先选择 ${tool.label} 使用的模型。`, "error");
    return;
  }
  button.disabled = true;
  byId("result").hidden = true;
  setMessage(byId("test-message"), "");
  byId(tool.model).disabled = true;
  byId(tool.custom).disabled = true;

  const challengeResponse = await fetch("/api/challenges");
  const challenges = (await challengeResponse.json()).challenges.slice(0, 3);
  const states = challenges.map(() => "pending");
  const outputs = [];
  const errors = [];
  let currentStatus = "准备检测";
  const startedAt = Date.now();
  const progressTimer = window.setInterval(() => {
    renderOneClickProgress(key, states, `${currentStatus} · 已等待 ${Math.floor((Date.now() - startedAt) / 1000)} 秒`);
  }, 1000);
  try {
    for (let index = 0; index < challenges.length; index += 1) {
      states[index] = "working";
      currentStatus = `会话 ${index + 1}/${challenges.length} 进行中`;
      renderOneClickProgress(key, states, currentStatus);
      try {
        const response = await fetch(tool.probeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: challenges[index].prompt,
            expected_count: challenges[index].expected_count,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `${tool.label} 会话失败`);
        if (payload.accepted) {
          outputs.push({ text: payload.text, expected_count: challenges[index].expected_count });
          states[index] = "done";
        } else {
          errors.push(`会话 ${index + 1}: 有效数字 ${payload.parsed_numbers}/${payload.minimum_numbers}`);
          states[index] = "invalid";
        }
      } catch (error) {
        errors.push(`会话 ${index + 1}: ${error.message}`);
        states[index] = "error";
      }
      currentStatus = `已获得 ${outputs.length}/${challenges.length} 份有效回答`;
      renderOneClickProgress(key, states, currentStatus);
    }
  } finally {
    window.clearInterval(progressTimer);
    byId(tool.model).disabled = false;
    byId(tool.custom).disabled = false;
  }

  if (!outputs.length) {
    renderOneClickProgress(key, states, "三个会话均未获得可用回答");
    setMessage(byId("test-message"), `没有获得可分析输出。${errors[0] || ""}`, "error");
    button.disabled = false;
    return;
  }

  renderOneClickProgress(key, states, "回答已收齐，正在计算归因概率……");
  const analysisResponse = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outputs }),
  });
  const result = await analysisResponse.json();
  if (analysisResponse.ok) {
    result.cli_test = { tool: tool.label, model, received: outputs.length, requested: challenges.length, errors };
    renderOneClickProgress(key, states, `检测完成：${outputs.length}/${challenges.length} 份有效回答进入归因`);
    renderResult(result);
  } else {
    setMessage(byId("test-message"), result.error || `${tool.label} 检测失败。`, "error");
  }
  button.disabled = false;
}

function updateUnifiedSummary(summary) {
  state.unified = summary;
  byId("topbar-bank-count").textContent = `${summary.model_count} 个候选模型`;
  byId("active-bank-badge").textContent = `${summary.model_count} 个候选模型`;
}

function renderInventory() {
  byId("selected-bank-name").textContent = state.bank.label;
  byId("model-options").innerHTML = state.bank.models.map((model) => `<option value="${escapeHtml(model.id)}"></option>`).join("");
  byId("bank-inventory").innerHTML = state.bank.models.length
    ? state.bank.models.map((model) => `<span class="fingerprint-item">${escapeHtml(model.display_name)}</span>`).join("")
    : `<span class="empty-inventory">暂无指纹</span>`;
}

async function refreshBank() {
  const response = await fetch(`/api/bank?bank_id=${encodeURIComponent(state.bankId)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "无法读取指纹库");
  state.bank = payload;
  renderInventory();
}

async function selectBank(bankId) {
  state.bankId = bankId;
  await refreshBank();
}

async function enrollAutomatically(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  const requested = Number(byId("sample-count").value);
  const started = Date.now();
  const progressTimer = window.setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    setMessage(byId("enrollment-message"), `正在自动识别协议并采集 ${requested} 份回答 · 已等待 ${seconds} 秒`, "working");
  }, 1000);
  setMessage(byId("enrollment-message"), `正在自动识别协议并采集 ${requested} 份回答`, "working");
  let response;
  try {
    response = await fetch("/api/enroll/auto", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: byId("api-base").value,
        api_key: byId("api-key").value,
        api_model: byId("api-model").value,
        bank_id: state.bankId,
        model_label: byId("auto-model").value,
        sample_count: requested,
        temperature: optionalNumber("temperature"),
      }),
    });
  } catch (error) {
    window.clearInterval(progressTimer);
    setMessage(byId("enrollment-message"), error.message, "error");
    button.disabled = false;
    return;
  }
  window.clearInterval(progressTimer);
  const payload = await response.json();
  if (response.ok) {
    state.bank = payload.bank;
    updateUnifiedSummary(payload.unified);
    renderInventory();
    setMessage(byId("enrollment-message"), `采集完成：收到 ${payload.received}/${payload.requested} 份，${payload.accepted} 份进入指纹库，${payload.rejected} 份无效，${payload.errors.length} 次接口错误。`, "success");
  } else {
    setMessage(byId("enrollment-message"), payload.error || "自动采集失败。", "error");
  }
  button.disabled = false;
}

function renderBankOptions(summaries, selected) {
  byId("bank-select").innerHTML = Object.entries(summaries)
    .map(([bankId, bank]) => `<option value="${escapeHtml(bankId)}"${bankId === selected ? " selected" : ""}>${escapeHtml(bank.label)}</option>`)
    .join("");
}

async function createBank(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  const response = await fetch("/api/banks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: byId("new-bank-name").value }),
  });
  const payload = await response.json();
  if (response.ok) {
    window.BANK_SUMMARIES = payload.banks;
    state.bankId = payload.bank.id;
    state.bank = payload.bank;
    updateUnifiedSummary(payload.unified);
    renderBankOptions(payload.banks, state.bankId);
    renderInventory();
    byId("new-bank-name").value = "";
    byId("create-bank-form").hidden = true;
    setMessage(byId("enrollment-message"), `已创建 ${payload.bank.label}`, "success");
  } else {
    setMessage(byId("enrollment-message"), payload.error || "创建失败。", "error");
  }
  button.disabled = false;
}

document.querySelectorAll("[data-workspace]").forEach((button) => button.addEventListener("click", () => activateWorkspace(button.dataset.workspace)));
document.querySelectorAll("[data-test-mode]").forEach((button) => button.addEventListener("click", () => activateMode("test", button.dataset.testMode)));
byId("bank-select").addEventListener("change", (event) => selectBank(event.target.value));
byId("regenerate").addEventListener("click", loadChallenges);
byId("analyze").addEventListener("click", analyzeManual);
byId("api-test-form").addEventListener("submit", testViaApi);
document.querySelector('[data-test-mode="codex"]').addEventListener("click", () => { if (!oneClickLoaded.codex) loadOneClickStatus("codex"); });
document.querySelector('[data-test-mode="claude"]').addEventListener("click", () => { if (!oneClickLoaded.claude) loadOneClickStatus("claude"); });
byId("codex-test-form").addEventListener("submit", (event) => runOneClickTest("codex", event));
byId("claude-test-form").addEventListener("submit", (event) => runOneClickTest("claude", event));
byId("auto-enrollment").addEventListener("submit", enrollAutomatically);
byId("show-create-bank").addEventListener("click", () => { byId("create-bank-form").hidden = !byId("create-bank-form").hidden; });
byId("create-bank-form").addEventListener("submit", createBank);

renderInventory();
loadChallenges();
