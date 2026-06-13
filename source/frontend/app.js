const ETHERSCAN_BASE_URL = "https://sepolia.etherscan.io";
const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";

const DEFAULT_CONTRACT_ADDRESS = "0xD9d8B45d0102e4Def881aE652dD205B08AB1D03e";

// 固定使用 0xD9d8...，避免 localStorage 舊地址干擾
localStorage.setItem("HVAC_CONTRACT_ADDRESS", DEFAULT_CONTRACT_ADDRESS);

let CONTRACT_ADDRESS = DEFAULT_CONTRACT_ADDRESS;

const HVAC_ABI = [
  "event CounterReset()",
  "event DataLogged(uint256 temp, uint256 humidity, uint256 currentCount)",
  "event ProjectAccepted(string message)",
  "function REQUIRED_COUNT() view returns (uint256)",
  "function TARGET_HUMIDITY() view returns (uint256)",
  "function TARGET_TEMP() view returns (uint256)",
  "function consecutiveSuccesses() view returns (uint256)",
  "function isAccepted() view returns (bool)",
  "function logData(uint256 _temp, uint256 _humidity)",
  "function resetCounter()"
];

const states = [
  "待啟動",
  "測試中",
  "驗收通過",
  "異常待處理",
  "驗收失敗"
];

let provider = null;
let signer = null;
let contract = null;
let listenersAttached = false;
let isAcceptedOnChain = false;
let processedEventKeys = new Set();

let currentIndex = 0;
let passedDays = 0;
let abnormalEvents = 0;
let eventRecords = [];

let activeSubmitDay = null;
let hasDailyMonitoringData = false;
let lastDailyMonitoringDay = 0;
let pendingRecoverableIssue = null;
let pendingRecoverableIssueDay = null;

let tempThreshold = 24;
let humidThreshold = 50;
let requiredDays = 30;

let chainReadCompatibility = {
  targetTempReadable: false,
  targetHumidityReadable: false,
  requiredCountReadable: false,
  consecutiveSuccessesReadable: false,
  isAcceptedReadable: false,
  usingRequiredCountFallback: true,
  usingSuccessCountFallback: true
};

let contractOptions = {
  requireConsecutive: true,
  resetOnNormalFail: true,
  autoAccept: true,
  autoReleasePayment: true,
  resetOnAbnormal: true,
  abnormalToPending: true,
  criticalFail: true
};

const DATA_TYPE_LABELS = {
  normal: "每日溫濕度監測",
  retest: "復測資料",
  supervisor_sample: "監造抽測資料",
  equipment_fault: "設備異常／機器損壞",
  sensor_fault: "感測器故障",
  network_fault: "通訊中斷",
  power_fault: "電力異常",
  environment_over_limit: "環境數值超限",
  maintenance: "維護保養紀錄",
  repair_done: "修復完成回報",
  resume_confirm: "復歸確認",
  manual_review: "人工覆核／監造註記"
};

const stateText = document.getElementById("stateText");
const progressBar = document.getElementById("progressBar");
const stateList = document.getElementById("stateList");
const walletStatus = document.getElementById("walletStatus");
const acceptRate = document.getElementById("acceptRate");
const abnormalCount = document.getElementById("abnormalCount");
const daysShow = document.getElementById("daysShow");
const ruleText = document.getElementById("ruleText");
const submitBtn = document.getElementById("submitBtn");
const connectBtn = document.getElementById("connectBtn");
const networkStatus = document.getElementById("networkStatus");
const downloadContractDataBtn = document.getElementById("downloadContractDataBtn");

const EVENT_LOOKBACK_BLOCKS = 120000;

function init() {
  initContractAddressUI();

  readThresholdSettings(false);
  readContractOptions();
  renderState();
  toggleDataFields();
  renderEventLog();
  updateContractSummary();
  updateWriteButtonState();

  log("系統初始化完成。此版本已針對 0xD9d8... 合約採用相容模式。", "info", {
    day: 0,
    category: "system"
  });

  log("相容模式：REQUIRED_COUNT() 或 consecutiveSuccesses() 若讀取失敗，將使用前端預設值與 DataLogged 事件 currentCount。", "info", {
    day: 0,
    category: "system"
  });

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", () => {
      location.reload();
    });

    window.ethereum.on("chainChanged", () => {
      location.reload();
    });
  }
}

function isNormalDataType(dataType) {
  return ["normal", "retest", "supervisor_sample"].includes(dataType);
}

function isDailyMonitoringData(dataType) {
  return dataType === "normal";
}

function isSupplementalMonitoringData(dataType) {
  return ["retest", "supervisor_sample"].includes(dataType);
}

function isMaintenanceDataType(dataType) {
  return ["maintenance", "repair_done", "resume_confirm", "manual_review"].includes(dataType);
}

function isAbnormalDataType(dataType) {
  return !isNormalDataType(dataType) && !isMaintenanceDataType(dataType);
}

function isRecoverableIssueDataType(dataType) {
  return ["network_fault", "environment_over_limit"].includes(dataType);
}

function getRecoverableIssueLabel(dataType) {
  const map = {
    network_fault: "通訊中斷",
    environment_over_limit: "環境數值超限"
  };

  return map[dataType] || "可補正事件";
}

function getDataTypeLabel(dataType) {
  return DATA_TYPE_LABELS[dataType] || "未知資料類型";
}

function getDataCategoryLabel(dataType) {
  if (isNormalDataType(dataType)) return "正常監測資料";
  if (isMaintenanceDataType(dataType)) return "維護覆核紀錄";
  return "異常事件";
}

function getProgressLogDay() {
  return passedDays > 0 ? passedDays : 0;
}

function getDayLabel(day) {
  return day === 0 ? "未計入鏈上成功次數" : `第 ${String(day).padStart(2, "0")} 次`;
}

function resolveSubmitDay(dataType) {
  if (isDailyMonitoringData(dataType)) return null;

  if (isSupplementalMonitoringData(dataType)) {
    if (pendingRecoverableIssueDay !== null) return pendingRecoverableIssueDay;
    return getProgressLogDay();
  }

  return getProgressLogDay();
}

function readThresholdSettings(normalizeInputs = true) {
  const tempValue = Number(document.getElementById("tempThresholdInput")?.value);
  const humidValue = Number(document.getElementById("humidThresholdInput")?.value);
  const daysValue = parseInt(document.getElementById("requiredDaysInput")?.value, 10);

  tempThreshold = tempValue > 0 ? tempValue : 24;
  humidThreshold = humidValue > 0 ? humidValue : 50;
  requiredDays = daysValue > 0 ? daysValue : 30;

  if (normalizeInputs) {
    document.getElementById("tempThresholdInput").value = tempThreshold;
    document.getElementById("humidThresholdInput").value = humidThreshold;
    document.getElementById("requiredDaysInput").value = requiredDays;
  }
}

function readContractOptions() {
  contractOptions.requireConsecutive = true;
  contractOptions.resetOnNormalFail = true;
  contractOptions.autoAccept = true;
  contractOptions.autoReleasePayment = true;
  contractOptions.resetOnAbnormal = true;
  contractOptions.abnormalToPending = true;
  contractOptions.criticalFail = true;
}

function countEnabledOptions() {
  return 3;
}

async function applyThresholdSettings() {
  if (contract) {
    await syncContractState(false);
  } else {
    readThresholdSettings(true);
    updateContractSummary();
    renderState();
  }
}

function showCurrentContractAddress() {
  log(`目前前端使用的合約地址：${CONTRACT_ADDRESS}`, "info", {
    day: 0,
    category: "system"
  });

  console.log("目前前端使用的合約地址：", CONTRACT_ADDRESS);
  console.log("localStorage HVAC_CONTRACT_ADDRESS：", localStorage.getItem("HVAC_CONTRACT_ADDRESS"));
}

async function diagnoseContract() {
  try {
    await ensureContractReady();

    log(`開始檢查合約地址：${CONTRACT_ADDRESS}`, "info", {
      day: 0,
      category: "system"
    });

    console.log("目前前端使用的 CONTRACT_ADDRESS:", CONTRACT_ADDRESS);
    console.log("localStorage HVAC_CONTRACT_ADDRESS:", localStorage.getItem("HVAC_CONTRACT_ADDRESS"));

    const network = await provider.getNetwork();

    console.log("目前網路:", {
      name: network.name,
      chainId: Number(network.chainId)
    });

    const code = await provider.getCode(CONTRACT_ADDRESS);

    if (!code || code === "0x") {
      log("檢查失敗：目前地址沒有合約 bytecode，這不是合約地址。", "critical", {
        day: 0,
        category: "system"
      });
      return;
    }

    log(`合約 bytecode 存在，長度：${code.length}`, "info", {
      day: 0,
      category: "system"
    });

    const checks = [
      ["TARGET_TEMP()", () => contract.TARGET_TEMP(), "targetTempReadable"],
      ["TARGET_HUMIDITY()", () => contract.TARGET_HUMIDITY(), "targetHumidityReadable"],
      ["REQUIRED_COUNT()", () => contract.REQUIRED_COUNT(), "requiredCountReadable"],
      ["consecutiveSuccesses()", () => contract.consecutiveSuccesses(), "consecutiveSuccessesReadable"],
      ["isAccepted()", () => contract.isAccepted(), "isAcceptedReadable"]
    ];

    for (const [label, fn, flagName] of checks) {
      try {
        const value = await fn();

        chainReadCompatibility[flagName] = true;

        log(`${label} 讀取成功：${value.toString()}`, "info", {
          day: 0,
          category: "system"
        });

        console.log(`${label} success:`, value.toString());
      } catch (error) {
        chainReadCompatibility[flagName] = false;

        console.error(`${label} failed full error:`, error);

        log(
          `${label} 讀取失敗：已啟用相容模式，不中斷前端流程。${formatContractError(error)}`,
          "info",
          {
            day: 0,
            category: "system"
          }
        );
      }
    }

    log("合約檢查完成。", "info", {
      day: 0,
      category: "system"
    });

    updateContractSummary();
  } catch (error) {
    console.error("diagnoseContract failed full error:", error);

    log(`合約檢查失敗：${formatContractError(error)}`, "critical", {
      day: 0,
      category: "system"
    });
  }
}

function updateContractSummary() {
  const summary = document.getElementById("contractSummary");
  const conditionStatus = document.getElementById("conditionStatus");
  const enabledConditions = document.getElementById("enabledConditions");

  const acceptedText = isAcceptedOnChain ? "是，已驗收通過" : "否，尚未驗收通過";
  const connectedText = contract
    ? "已連接合約，相容模式啟用"
    : "尚未連接錢包，顯示前端預設值";

  const requiredCountText = chainReadCompatibility.requiredCountReadable
    ? "鏈上讀取"
    : "前端預設 30";

  const successCountText = chainReadCompatibility.consecutiveSuccessesReadable
    ? "鏈上 getter 讀取"
    : "DataLogged 事件 / 前端狀態";

  summary.innerHTML = [
    `合約地址：${CONTRACT_ADDRESS}`,
    `目標條件：溫度 ≤ ${tempThreshold}°C、濕度 ≤ ${humidThreshold}%RH。`,
    `驗收次數條件：${requiredDays} 次（來源：${requiredCountText}）。`,
    `目前成功次數：${passedDays} / ${requiredDays}（來源：${successCountText}）。`,
    `isAccepted：${acceptedText}。`,
    `寫入函數：logData(uint256 _temp, uint256 _humidity)。`,
    `重置函數：resetCounter()。`,
    `相容模式：REQUIRED_COUNT() 與 consecutiveSuccesses() 若無法讀取，不會阻擋送出交易。`
  ].join("<br>");

  conditionStatus.innerText = connectedText;
  enabledConditions.innerText = countEnabledOptions();

  if (ruleText) {
    ruleText.innerText =
      `本版本相容 0xD9d8... 合約。TARGET_TEMP、TARGET_HUMIDITY、isAccepted 會優先讀鏈上；` +
      `REQUIRED_COUNT 若讀取失敗，使用前端預設 30；consecutiveSuccesses 若讀取失敗，` +
      `改由 DataLogged 事件的 currentCount 或前端目前狀態更新。送出 logData() 仍需 Sepolia 測試 ETH 支付 Gas。`;
  }
}

function renderState() {
  const currentState = states[currentIndex];

  stateText.innerText = currentState;
  stateText.classList.remove("failed", "pass", "pending", "warning");

  if (currentState === "待啟動" || currentState === "測試中") stateText.classList.add("pending");
  if (currentState === "驗收通過") stateText.classList.add("pass");
  if (currentState === "異常待處理") stateText.classList.add("warning");
  if (currentState === "驗收失敗") stateText.classList.add("failed");

  const rate = requiredDays > 0
    ? Math.min(Math.round((passedDays / requiredDays) * 100), 100)
    : 0;

  progressBar.style.width = `${rate}%`;

  stateList.innerHTML = "";
  states.forEach((item, index) => {
    const chip = document.createElement("div");
    chip.className = "state-chip";

    if (index === currentIndex) {
      if (item === "驗收通過") chip.classList.add("pass-active");
      else if (item === "異常待處理") chip.classList.add("warning-active");
      else if (item === "驗收失敗") chip.classList.add("failed-active");
      else chip.classList.add("active");
    }

    chip.innerText = item;
    stateList.appendChild(chip);
  });

  updateProgressDisplays();
  updateWriteButtonState();
}

function updateProgressDisplays() {
  const rate = requiredDays > 0
    ? Math.min(Math.round((passedDays / requiredDays) * 100), 100)
    : 0;

  daysShow.innerText = `${passedDays} / ${requiredDays}`;
  acceptRate.innerText = `${rate}%`;
  abnormalCount.innerText = abnormalEvents;
}

function updateWriteButtonState() {
  if (submitBtn) {
    if (isAcceptedOnChain) {
      submitBtn.disabled = true;
      submitBtn.innerText = "已驗收通過，停止送出";
      submitBtn.style.opacity = "0.55";
      submitBtn.style.cursor = "not-allowed";
    } else {
      submitBtn.disabled = false;
      submitBtn.innerText = "送出鏈上資料";
      submitBtn.style.opacity = "1";
      submitBtn.style.cursor = "pointer";
    }
  }

  if (downloadContractDataBtn) {
    downloadContractDataBtn.disabled = false;
    downloadContractDataBtn.innerText = contract ? "下載鏈上資料" : "下載目前資料";
    downloadContractDataBtn.style.opacity = "1";
    downloadContractDataBtn.style.cursor = "pointer";
  }
}

function log(message, type = "info", extra = {}) {
  const now = new Date();

  const day =
    Number.isInteger(extra.day)
      ? extra.day
      : activeSubmitDay !== null
        ? activeSubmitDay
        : 0;

  eventRecords.unshift({
    id: Date.now() + Math.random(),
    type,
    message,
    time: now.toLocaleTimeString("zh-TW", { hour12: false }),
    day,
    category: extra.category || type
  });

  renderEventLog();
}

function renderEventLog() {
  const filter = document.getElementById("logFilter")
    ? document.getElementById("logFilter").value
    : "all";

  const list = document.getElementById("eventLog");

  const records = filter === "all"
    ? eventRecords
    : eventRecords.filter(item => item.type === filter);

  updateLogSummary();

  if (!records.length) {
    list.innerHTML = `<div class="event-empty">目前沒有符合條件的鏈上事件紀錄</div>`;
    return;
  }

  const grouped = records.reduce((acc, item) => {
    const key = item.day || 0;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  const dayKeys = Object.keys(grouped)
    .map(Number)
    .sort((a, b) => b - a);

  list.innerHTML = dayKeys.map(day => {
    const title = day === 0
      ? "系統／未計入鏈上成功次數"
      : `第 ${String(day).padStart(2, "0")} 次`;

    const cards = grouped[day].map(item => {
      const meta = getEventMeta(item.type);

      return `
        <div class="event-card ${escapeHtml(item.type)}" data-category="${escapeHtml(item.category || item.type)}">
          <div class="event-top">
            <span class="event-badge">${meta.icon} ${meta.label}</span>
            <span class="event-time">${item.time}</span>
          </div>
          <div class="event-message">${escapeHtml(item.message)}</div>
        </div>
      `;
    }).join("");

    return `
      <section class="event-day-group">
        <div class="event-day-title">${title}</div>
        ${cards}
      </section>
    `;
  }).join("");
}

function getEventMeta(type) {
  const map = {
    info: { label: "一般紀錄", icon: "●" },
    oracle: { label: "DataLogged", icon: "◆" },
    state: { label: "狀態事件", icon: "↻" },
    abnormal: { label: "異常註記", icon: "!" },
    maintenance: { label: "維護覆核", icon: "◇" },
    critical: { label: "重大異常", icon: "⚠" },
    payment: { label: "付款事件", icon: "$" }
  };

  return map[type] || map.info;
}

function updateLogSummary() {
  document.getElementById("logTotal").innerText = eventRecords.length;
  document.getElementById("logOracle").innerText =
    eventRecords.filter(item => item.type === "oracle").length;
  document.getElementById("logAbnormal").innerText =
    eventRecords.filter(item => item.type === "abnormal" || item.type === "critical").length;
  document.getElementById("logCritical").innerText =
    eventRecords.filter(item => item.type === "critical").length;
}

function clearEventLog() {
  eventRecords = [];
  renderEventLog();
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toggleDataFields() {
  const dataType = document.getElementById("dataType").value;
  const normalFields = document.getElementById("normalFields");
  const dataHint = document.getElementById("dataHint");

  if (isNormalDataType(dataType)) {
    normalFields.style.display = "grid";

    if (isDailyMonitoringData(dataType)) {
      dataHint.innerText =
        `${getDataTypeLabel(dataType)}會實際呼叫 logData() 寫入鏈上。請輸入整數；送出交易需要 Sepolia 測試 ETH 支付 Gas。`;
    } else {
      dataHint.innerText =
        `${getDataTypeLabel(dataType)}僅為前端補充紀錄，不會呼叫 logData()，也不會直接改變鏈上狀態。`;
    }

    return;
  }

  normalFields.style.display = "none";

  if (isMaintenanceDataType(dataType)) {
    dataHint.innerText =
      `${getDataTypeLabel(dataType)}僅為前端維護覆核紀錄，不會寫入 HVACAcceptance 合約。`;
    return;
  }

  dataHint.innerText =
    `${getDataTypeLabel(dataType)}僅為前端異常註記，不會呼叫 logData()，也不會直接改變鏈上狀態。`;
}

async function switchToSepolia() {
  const chainId = await window.ethereum.request({ method: "eth_chainId" });

  if (chainId === SEPOLIA_CHAIN_ID_HEX) return;

  await window.ethereum.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }]
  });
}

async function assertContractExists() {
  if (!provider) {
    throw new Error("尚未建立 provider。");
  }

  const code = await provider.getCode(CONTRACT_ADDRESS);

  if (!code || code === "0x") {
    throw new Error(
      `目前 Sepolia 找不到此合約 bytecode：${CONTRACT_ADDRESS}。請確認地址是否正確。`
    );
  }

  console.log("Contract bytecode length:", code.length);

  return true;
}

function getFriendlyError(error) {
  const message = error?.message || "";
  const reason = error?.reason || "";
  const code = error?.code;

  if (code === 4001 || message.includes("user rejected") || message.includes("User rejected")) {
    return "你已在 MetaMask 取消或拒絕本次請求。";
  }

  if (
    message.includes("insufficient funds") ||
    message.includes("not enough funds") ||
    message.includes("exceeds balance")
  ) {
    return "Sepolia 測試 ETH 不足。請先到 Sepolia Faucet 領取測試 ETH，再重新送出交易。";
  }

  if (message.includes("already accepted") || reason.includes("already accepted")) {
    return "合約已驗收通過，不能再送出新的 logData()。如需重新測試，請先執行 resetCounter()。";
  }

  if (message.includes("missing revert data") || code === "CALL_EXCEPTION") {
    return "鏈上呼叫失敗。若是讀取 REQUIRED_COUNT() 或 consecutiveSuccesses()，本版會自動改用相容模式；若是送出交易，請確認 logData() 在此合約可用且帳戶有 Sepolia 測試 ETH。";
  }

  if (message.includes("network") || message.includes("chain")) {
    return "網路切換失敗。請手動將 MetaMask 切換至 Sepolia 後再試。";
  }

  return reason || message || "未知錯誤。";
}

function formatContractError(error) {
  if (!error) return "未知錯誤。";

  const parts = [];

  if (error.code) parts.push(`code=${error.code}`);
  if (error.reason) parts.push(`reason=${error.reason}`);
  if (error.shortMessage) parts.push(`shortMessage=${error.shortMessage}`);
  if (error.message) parts.push(`message=${error.message}`);

  if (error.data) {
    try {
      parts.push(`data=${JSON.stringify(error.data)}`);
    } catch {
      parts.push(`data=${String(error.data)}`);
    }
  }

  return parts.length ? parts.join("；") : String(error);
}

async function connectWallet() {
  if (!window.ethereum) {
    walletStatus.innerText = "MetaMask 未安裝";
    log("未偵測到 MetaMask；請安裝 MetaMask 後再操作。", "critical", {
      day: 0,
      category: "system"
    });
    return;
  }

  try {
    await switchToSepolia();

    await window.ethereum.request({
      method: "eth_requestAccounts"
    });

    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();

    await assertContractExists();

    contract = new ethers.Contract(CONTRACT_ADDRESS, HVAC_ABI, signer);

    const address = await signer.getAddress();
    walletStatus.innerText = `${address.slice(0, 6)}...${address.slice(-4)}`;
    networkStatus.innerText = "Sepolia Connected";
    connectBtn.innerText = "已連接 MetaMask";

    attachContractListeners();
    await syncContractState(false);

    log("MetaMask 已連接。已啟用 0xD9d8... 相容讀取模式。", "info", {
      day: 0,
      category: "system"
    });
  } catch (error) {
    console.error(error);

    walletStatus.innerText = "Wallet Not Connected";
    networkStatus.innerText = "Sepolia Not Ready";
    connectBtn.innerText = "連接 MetaMask";

    log(`連接失敗：${getFriendlyError(error)}`, "critical", {
      day: 0,
      category: "system"
    });
  }
}

async function ensureContractReady() {
  if (!contract) {
    await connectWallet();
  }

  if (!contract || !provider) {
    throw new Error("尚未成功連接合約。");
  }

  await assertContractExists();
}

async function syncContractState(silent = true) {
  if (!contract || !provider) return;

  try {
    await assertContractExists();

    let targetTemp = tempThreshold || 24;
    let targetHumidity = humidThreshold || 50;
    let requiredCount = requiredDays || 30;
    let currentCount = passedDays || 0;
    let accepted = isAcceptedOnChain || false;

    try {
      targetTemp = Number(await contract.TARGET_TEMP());
      chainReadCompatibility.targetTempReadable = true;
      if (!silent) {
        log(`TARGET_TEMP() 讀取成功：${targetTemp}`, "info", {
          day: 0,
          category: "system"
        });
      }
    } catch (error) {
      chainReadCompatibility.targetTempReadable = false;
      if (!silent) {
        log("TARGET_TEMP() 讀取失敗，改用前端預設值。", "critical", {
          day: 0,
          category: "system"
        });
      }
    }

    try {
      targetHumidity = Number(await contract.TARGET_HUMIDITY());
      chainReadCompatibility.targetHumidityReadable = true;
      if (!silent) {
        log(`TARGET_HUMIDITY() 讀取成功：${targetHumidity}`, "info", {
          day: 0,
          category: "system"
        });
      }
    } catch (error) {
      chainReadCompatibility.targetHumidityReadable = false;
      if (!silent) {
        log("TARGET_HUMIDITY() 讀取失敗，改用前端預設值。", "critical", {
          day: 0,
          category: "system"
        });
      }
    }

    try {
      requiredCount = Number(await contract.REQUIRED_COUNT());
      chainReadCompatibility.requiredCountReadable = true;
      chainReadCompatibility.usingRequiredCountFallback = false;
      if (!silent) {
        log(`REQUIRED_COUNT() 讀取成功：${requiredCount}`, "info", {
          day: 0,
          category: "system"
        });
      }
    } catch (error) {
      requiredCount = 30;
      chainReadCompatibility.requiredCountReadable = false;
      chainReadCompatibility.usingRequiredCountFallback = true;
      if (!silent) {
        log("REQUIRED_COUNT() 讀取失敗，改用前端預設值 30。", "info", {
          day: 0,
          category: "system"
        });
      }
    }

    try {
      currentCount = Number(await contract.consecutiveSuccesses());
      chainReadCompatibility.consecutiveSuccessesReadable = true;
      chainReadCompatibility.usingSuccessCountFallback = false;
      if (!silent) {
        log(`consecutiveSuccesses() 讀取成功：${currentCount}`, "info", {
          day: 0,
          category: "system"
        });
      }
    } catch (error) {
      currentCount = passedDays || 0;
      chainReadCompatibility.consecutiveSuccessesReadable = false;
      chainReadCompatibility.usingSuccessCountFallback = true;
      if (!silent) {
        log("consecutiveSuccesses() 讀取失敗，改以前端目前進度或 DataLogged 事件 currentCount 為準。", "info", {
          day: 0,
          category: "system"
        });
      }
    }

    try {
      accepted = Boolean(await contract.isAccepted());
      chainReadCompatibility.isAcceptedReadable = true;
      if (!silent) {
        log(`isAccepted() 讀取成功：${accepted}`, "info", {
          day: 0,
          category: "system"
        });
      }
    } catch (error) {
      chainReadCompatibility.isAcceptedReadable = false;
      if (!silent) {
        log("isAccepted() 讀取失敗，改用前端目前狀態。", "critical", {
          day: 0,
          category: "system"
        });
      }
    }

    tempThreshold = targetTemp;
    humidThreshold = targetHumidity;
    requiredDays = requiredCount;
    passedDays = currentCount;
    isAcceptedOnChain = accepted;

    hasDailyMonitoringData = passedDays > 0;
    lastDailyMonitoringDay = passedDays;

    document.getElementById("tempThresholdInput").value = tempThreshold;
    document.getElementById("humidThresholdInput").value = humidThreshold;
    document.getElementById("requiredDaysInput").value = requiredDays;

    if (isAcceptedOnChain) {
      currentIndex = 2;
    } else if (passedDays > 0) {
      currentIndex = 1;
    } else {
      currentIndex = 0;
    }

    updateContractSummary();
    renderState();

    if (!silent) {
      log(
        `已同步可讀鏈上狀態：TARGET_TEMP=${tempThreshold}，TARGET_HUMIDITY=${humidThreshold}，目前進度=${passedDays}/${requiredDays}，isAccepted=${isAcceptedOnChain}。`,
        "info",
        {
          day: 0,
          category: "system"
        }
      );
    }
  } catch (error) {
    console.error(error);

    log(`讀取鏈上狀態失敗：${formatContractError(error)}`, "critical", {
      day: 0,
      category: "system"
    });
  }
}

function attachContractListeners() {
  if (!contract || listenersAttached) return;

  contract.on("DataLogged", (temp, humidity, currentCount, event) => {
    const txHash = event?.log?.transactionHash || "";
    const logIndex = event?.log?.index ?? "";
    const key = `DataLogged-${txHash}-${logIndex}`;

    if (processedEventKeys.has(key)) return;
    processedEventKeys.add(key);

    handleDataLoggedEvent(Number(temp), Number(humidity), Number(currentCount), txHash);
  });

  contract.on("ProjectAccepted", (message, event) => {
    const txHash = event?.log?.transactionHash || "";
    const logIndex = event?.log?.index ?? "";
    const key = `ProjectAccepted-${txHash}-${logIndex}`;

    if (processedEventKeys.has(key)) return;
    processedEventKeys.add(key);

    handleProjectAcceptedEvent(message);
  });

  contract.on("CounterReset", (event) => {
    const txHash = event?.log?.transactionHash || "";
    const logIndex = event?.log?.index ?? "";
    const key = `CounterReset-${txHash}-${logIndex}`;

    if (processedEventKeys.has(key)) return;
    processedEventKeys.add(key);

    handleCounterResetEvent();
  });

  listenersAttached = true;
}

function handleDataLoggedEvent(temp, humidity, currentCount, txHash = "") {
  passedDays = Number(currentCount) || 0;
  hasDailyMonitoringData = passedDays > 0;
  lastDailyMonitoringDay = passedDays;

  document.getElementById("tempShow").innerText = `${temp}°C`;
  document.getElementById("humidShow").innerText = `${humidity}%`;

  const isPass = temp <= tempThreshold && humidity <= humidThreshold;

  if (passedDays > 0) {
    currentIndex = 1;
    activeSubmitDay = passedDays;
  } else {
    currentIndex = isAcceptedOnChain ? 2 : 3;
    activeSubmitDay = 0;
  }

  log(
    `DataLogged：temp=${temp}, humidity=${humidity}, currentCount=${currentCount}${txHash ? `，Tx=${txHash.slice(0, 10)}...` : ""}。`,
    isPass ? "oracle" : "abnormal",
    { category: isPass ? "normal" : "abnormal" }
  );

  activeSubmitDay = null;
  updateContractSummary();
  renderState();
}

function handleProjectAcceptedEvent(message) {
  isAcceptedOnChain = true;
  passedDays = requiredDays;
  hasDailyMonitoringData = true;
  lastDailyMonitoringDay = requiredDays;
  currentIndex = 2;
  activeSubmitDay = requiredDays;

  log(`ProjectAccepted：${message}`, "state", {
    category: "normal"
  });

  activeSubmitDay = null;
  updateContractSummary();
  renderState();
}

function handleCounterResetEvent() {
  resetLocalState(true);

  log("CounterReset：鏈上計數已重置。", "state", {
    day: 0,
    category: "system"
  });

  renderState();
  updateContractSummary();
}

function resetLocalState(clearLogs = false) {
  currentIndex = 0;
  passedDays = 0;
  abnormalEvents = 0;
  activeSubmitDay = null;
  hasDailyMonitoringData = false;
  lastDailyMonitoringDay = 0;
  pendingRecoverableIssue = null;
  pendingRecoverableIssueDay = null;
  isAcceptedOnChain = false;

  document.getElementById("tempInput").value = 23;
  document.getElementById("humidInput").value = 45;
  document.getElementById("tempShow").innerText = "23°C";
  document.getElementById("humidShow").innerText = "45%";
  document.getElementById("dataType").value = "normal";
  document.getElementById("severity").value = "info";
  document.getElementById("eventNote").value = "";
  document.getElementById("logFilter").value = "all";

  if (clearLogs) {
    eventRecords = [];
    processedEventKeys = new Set();
  }

  toggleDataFields();
  renderEventLog();
}

function getIntegerInputValue(id, label) {
  const value = Number(document.getElementById(id).value);

  if (!Number.isInteger(value)) {
    throw new Error(`${label} 必須為整數，不能輸入小數點。`);
  }

  if (value < 0) {
    throw new Error(`${label} 不得為負數。`);
  }

  return value;
}

async function submitData() {
  readContractOptions();

  const dataType = document.getElementById("dataType").value;
  const severity = document.getElementById("severity").value;
  const note = document.getElementById("eventNote").value.trim();

  if (!isDailyMonitoringData(dataType)) {
    handleFrontendOnlyEvent(dataType, severity, note);
    return;
  }

  try {
    await ensureContractReady();

    let accepted = isAcceptedOnChain;

    try {
      accepted = Boolean(await contract.isAccepted());
    } catch (error) {
      accepted = isAcceptedOnChain;
    }

    if (accepted) {
      isAcceptedOnChain = true;
      updateWriteButtonState();

      log("合約已驗收通過，已停止送出新資料，避免浪費 Gas Fee。", "state", {
        day: requiredDays,
        category: "normal"
      });
      return;
    }

    const temp = getIntegerInputValue("tempInput", "溫度");
    const humidity = getIntegerInputValue("humidInput", "濕度");

    submitBtn.disabled = true;
    submitBtn.innerText = "交易送出中...";

    log(`準備呼叫 logData(${temp}, ${humidity})，請於 MetaMask 確認交易。`, "info", {
      day: getProgressLogDay(),
      category: "system"
    });

    const tx = await contract.logData(BigInt(temp), BigInt(humidity));

    log(`交易已送出：${tx.hash.slice(0, 10)}...，等待鏈上確認。`, "info", {
      day: getProgressLogDay(),
      category: "system"
    });

    const receipt = await tx.wait();
    handleReceiptEvents(receipt);

    await syncContractState(true);
  } catch (error) {
    console.error(error);

    log(`送出失敗：${getFriendlyError(error)}`, "critical", {
      day: getProgressLogDay(),
      category: "system"
    });
  } finally {
    updateWriteButtonState();
  }
}

function handleReceiptEvents(receipt) {
  if (!contract || !receipt || !receipt.logs) return;

  receipt.logs.forEach((rawLog, index) => {
    try {
      const parsed = contract.interface.parseLog(rawLog);
      const key = `${parsed.name}-${receipt.hash}-${index}`;

      if (processedEventKeys.has(key)) return;
      processedEventKeys.add(key);

      if (parsed.name === "DataLogged") {
        handleDataLoggedEvent(
          Number(parsed.args.temp),
          Number(parsed.args.humidity),
          Number(parsed.args.currentCount),
          receipt.hash
        );
      }

      if (parsed.name === "ProjectAccepted") {
        handleProjectAcceptedEvent(String(parsed.args.message));
      }

      if (parsed.name === "CounterReset") {
        handleCounterResetEvent();
      }
    } catch (error) {
      // 非本合約事件，略過
    }
  });
}

function handleFrontendOnlyEvent(dataType, severity, note) {
  activeSubmitDay = resolveSubmitDay(dataType);
  const typeText = getDataTypeLabel(dataType);

  log(
    `${getDayLabel(activeSubmitDay)} 前端註記：${getDataCategoryLabel(dataType)}／${typeText}。此紀錄不會寫入 HVACAcceptance 合約。`,
    isMaintenanceDataType(dataType) ? "maintenance" : isAbnormalDataType(dataType) ? "abnormal" : "info",
    {
      category: isMaintenanceDataType(dataType)
        ? "maintenance"
        : isAbnormalDataType(dataType)
          ? "abnormal"
          : "normal"
    }
  );

  if (isSupplementalMonitoringData(dataType)) {
    handleSupplementalData(dataType, note);
  } else if (isMaintenanceDataType(dataType)) {
    handleMaintenanceEvent(dataType, severity, note);
  } else {
    handleNonNormalFrontendEvent(dataType, severity, note);
  }

  activeSubmitDay = null;
  renderState();
}

function handleSupplementalData(dataType, note) {
  const typeText = getDataTypeLabel(dataType);

  if (!hasDailyMonitoringData) {
    log(`${typeText}無效：尚未有鏈上每日溫濕度監測成功紀錄作為基礎。`, "info", {
      category: "normal"
    });
    return;
  }

  if (!pendingRecoverableIssue) {
    log(`${typeText}已登錄為前端補充紀錄；不會呼叫 logData()，也不會改變鏈上成功次數。`, "info", {
      category: "normal"
    });
    return;
  }

  log(`${typeText}已作為 ${getRecoverableIssueLabel(pendingRecoverableIssue)} 的前端補充紀錄；鏈上成功次數仍維持 ${passedDays} / ${requiredDays}。`, "info", {
    category: "normal"
  });

  pendingRecoverableIssue = null;
  pendingRecoverableIssueDay = null;

  if (note) {
    log(`備註：${note}`, "info", {
      category: "normal"
    });
  }
}

function handleMaintenanceEvent(dataType, severity, note) {
  const severityText = getSeverityLabel(severity);

  log(`${getDataTypeLabel(dataType)}，等級：${severityText}。此為前端維護覆核紀錄，不影響鏈上驗收狀態。`, "maintenance", {
    category: "maintenance"
  });

  if (note) {
    log(`維護覆核備註：${note}`, "maintenance", {
      category: "maintenance"
    });
  }
}

function handleNonNormalFrontendEvent(dataType, severity, note) {
  const severityText = getSeverityLabel(severity);
  abnormalEvents++;

  if (isRecoverableIssueDataType(dataType)) {
    pendingRecoverableIssue = dataType;
    pendingRecoverableIssueDay = getProgressLogDay();

    log(`${getDataTypeLabel(dataType)}，等級：${severityText}。此為前端可補正註記，不會改變鏈上成功次數。`, "abnormal", {
      category: "abnormal"
    });
  } else {
    log(`${getDataTypeLabel(dataType)}，等級：${severityText}。此為前端異常註記，不會直接呼叫合約。`, severity === "critical" ? "critical" : "abnormal", {
      category: "abnormal"
    });
  }

  if (note) {
    log(`異常說明：${note}`, severity === "critical" ? "critical" : "abnormal", {
      category: "abnormal"
    });
  }

  updateProgressDisplays();
}

function getSeverityLabel(severity) {
  const map = {
    info: "一般紀錄",
    warning: "警示",
    critical: "重大異常"
  };

  return map[severity] || "一般紀錄";
}

function randomQualifiedData() {
  const maxTemp = Math.floor(tempThreshold);
  const minTemp = Math.max(0, maxTemp - 2);
  const maxHumid = Math.floor(humidThreshold);
  const minHumid = Math.max(0, maxHumid - 10);

  const temp = randomInteger(minTemp, maxTemp);
  const humidity = randomInteger(minHumid, maxHumid);

  document.getElementById("dataType").value = "normal";
  document.getElementById("severity").value = "info";
  document.getElementById("tempInput").value = temp;
  document.getElementById("humidInput").value = humidity;
  document.getElementById("tempShow").innerText = `${temp}°C`;
  document.getElementById("humidShow").innerText = `${humidity}%`;

  toggleDataFields();

  log(`已依目前門檻產生合格整數：${temp}°C / ${humidity}%RH。此動作尚未送出交易。`, "info", {
    day: 0,
    category: "system"
  });
}

async function resetCounterOnChain() {
  try {
    await ensureContractReady();

    log("準備呼叫 resetCounter()，請於 MetaMask 確認交易。", "info", {
      day: 0,
      category: "system"
    });

    const tx = await contract.resetCounter();

    log(`重置交易已送出：${tx.hash.slice(0, 10)}...，等待鏈上確認。`, "info", {
      day: 0,
      category: "system"
    });

    const receipt = await tx.wait();
    handleReceiptEvents(receipt);

    await syncContractState(true);
  } catch (error) {
    console.error(error);

    log(`重置失敗：${getFriendlyError(error)}`, "critical", {
      day: 0,
      category: "system"
    });
  }
}

function randomInteger(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);

  if (max < min) return min;

  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function copyAddress() {
  navigator.clipboard.writeText(CONTRACT_ADDRESS)
    .then(() => log("合約地址已複製。", "info", {
      day: 0,
      category: "system"
    }))
    .catch(() => log("瀏覽器未允許複製，請手動複製合約地址。", "info", {
      day: 0,
      category: "system"
    }));
}

async function getContractSnapshot() {
  await ensureContractReady();

  const snapshot = {
    targetTemp: tempThreshold,
    targetHumidity: humidThreshold,
    requiredCount: requiredDays || 30,
    consecutiveSuccesses: passedDays || 0,
    isAccepted: isAcceptedOnChain,
    readWarnings: [],
    compatibilityMode: true,
    contractAddress: CONTRACT_ADDRESS
  };

  try {
    snapshot.targetTemp = Number(await contract.TARGET_TEMP());
  } catch (error) {
    snapshot.readWarnings.push("TARGET_TEMP() 讀取失敗，使用前端目前值。");
  }

  try {
    snapshot.targetHumidity = Number(await contract.TARGET_HUMIDITY());
  } catch (error) {
    snapshot.readWarnings.push("TARGET_HUMIDITY() 讀取失敗，使用前端目前值。");
  }

  try {
    snapshot.requiredCount = Number(await contract.REQUIRED_COUNT());
  } catch (error) {
    snapshot.requiredCount = 30;
    snapshot.readWarnings.push("REQUIRED_COUNT() 讀取失敗，使用前端預設值 30。");
  }

  try {
    snapshot.consecutiveSuccesses = Number(await contract.consecutiveSuccesses());
  } catch (error) {
    snapshot.consecutiveSuccesses = passedDays || 0;
    snapshot.readWarnings.push("consecutiveSuccesses() 讀取失敗，使用前端目前進度或事件 currentCount。");
  }

  try {
    snapshot.isAccepted = Boolean(await contract.isAccepted());
  } catch (error) {
    snapshot.readWarnings.push("isAccepted() 讀取失敗，使用前端目前狀態。");
  }

  return snapshot;
}

function getFrontendSnapshot() {
  return {
    tempThreshold,
    humidThreshold,
    requiredDays,
    passedDays,
    isAcceptedOnChain,
    currentState: states[currentIndex],
    chainReadCompatibility,
    currentInput: {
      dataType: document.getElementById("dataType")?.value || null,
      dataTypeLabel: getDataTypeLabel(document.getElementById("dataType")?.value || ""),
      severity: document.getElementById("severity")?.value || null,
      tempInput: document.getElementById("tempInput")?.value || null,
      humidInput: document.getElementById("humidInput")?.value || null,
      eventNote: document.getElementById("eventNote")?.value || ""
    },
    uiStatus: {
      walletStatus: walletStatus?.innerText || "",
      networkStatus: networkStatus?.innerText || "",
      submitButtonText: submitBtn?.innerText || "",
      downloadButtonText: downloadContractDataBtn?.innerText || ""
    }
  };
}

async function queryRecentContractEvents(lookbackBlocks = EVENT_LOOKBACK_BLOCKS) {
  const result = {
    fromBlock: null,
    toBlock: null,
    lookbackBlocks,
    events: [],
    warning: null
  };

  try {
    await ensureContractReady();

    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - lookbackBlocks);

    result.fromBlock = fromBlock;
    result.toBlock = latestBlock;

    const dataLogs = await contract.queryFilter(
      contract.filters.DataLogged(),
      fromBlock,
      latestBlock
    );

    const acceptedLogs = await contract.queryFilter(
      contract.filters.ProjectAccepted(),
      fromBlock,
      latestBlock
    );

    const resetLogs = await contract.queryFilter(
      contract.filters.CounterReset(),
      fromBlock,
      latestBlock
    );

    dataLogs.forEach((event) => {
      result.events.push({
        eventName: "DataLogged",
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.index ?? event.logIndex ?? null,
        args: {
          temp: Number(event.args.temp),
          humidity: Number(event.args.humidity),
          currentCount: Number(event.args.currentCount)
        }
      });
    });

    acceptedLogs.forEach((event) => {
      result.events.push({
        eventName: "ProjectAccepted",
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.index ?? event.logIndex ?? null,
        args: {
          message: String(event.args.message)
        }
      });
    });

    resetLogs.forEach((event) => {
      result.events.push({
        eventName: "CounterReset",
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.index ?? event.logIndex ?? null,
        args: {}
      });
    });

    result.events.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      return (a.logIndex || 0) - (b.logIndex || 0);
    });

    return result;
  } catch (error) {
    console.error(error);

    result.warning =
      `事件查詢失敗：${getFriendlyError ? getFriendlyError(error) : error.message}`;

    return result;
  }
}

function downloadJsonFile(data, filename) {
  const blob = new Blob(
    [JSON.stringify(data, null, 2)],
    { type: "application/json;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();

  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function downloadContractData() {
  let signerAddress = null;
  let networkInfo = null;
  let chainSnapshot = null;
  let recentEvents = null;
  let chainReadStatus = {
    connected: false,
    success: false,
    warning: null
  };

  try {
    if (downloadContractDataBtn) {
      downloadContractDataBtn.disabled = true;
      downloadContractDataBtn.innerText = "資料整理中...";
    }

    if (signer) {
      try {
        signerAddress = await signer.getAddress();
      } catch (error) {
        signerAddress = null;
      }
    }

    if (provider) {
      try {
        const network = await provider.getNetwork();
        networkInfo = {
          name: network.name || "unknown",
          chainId: Number(network.chainId)
        };
      } catch (error) {
        networkInfo = null;
      }
    }

    if (contract && provider) {
      chainReadStatus.connected = true;

      try {
        chainSnapshot = await getContractSnapshot();
        recentEvents = await queryRecentContractEvents(EVENT_LOOKBACK_BLOCKS);
        chainReadStatus.success = true;
      } catch (error) {
        chainReadStatus.success = false;
        chainReadStatus.warning =
          `鏈上資料讀取失敗：${typeof getFriendlyError === "function" ? getFriendlyError(error) : error.message}`;
      }
    } else {
      chainReadStatus.warning = "尚未成功同步合約；本次僅匯出前端目前資料與事件紀錄。";
    }

    const exportData = {
      exportedAt: new Date().toISOString(),
      exportSource: "HVACAcceptance Frontend Dashboard",
      network: networkInfo || {
        name: "unknown",
        chainId: null
      },
      contract: {
        address: CONTRACT_ADDRESS,
        etherscanUrl: `${ETHERSCAN_BASE_URL}/address/${CONTRACT_ADDRESS}`,
        chainReadStatus,
        compatibilityMode: true,
        compatibilityNote:
          "此版本相容 0xD9d8... 合約。REQUIRED_COUNT() 與 consecutiveSuccesses() 若讀取失敗，改用前端預設值與 DataLogged 事件 currentCount。",
        abiFunctionsExpected: [
          "TARGET_TEMP()",
          "TARGET_HUMIDITY()",
          "REQUIRED_COUNT()",
          "consecutiveSuccesses()",
          "isAccepted()",
          "logData(uint256,uint256)",
          "resetCounter()"
        ],
        eventsExpected: [
          "DataLogged(uint256,uint256,uint256)",
          "ProjectAccepted(string)",
          "CounterReset()"
        ]
      },
      wallet: {
        connectedAddress: signerAddress
      },
      chainSnapshot,
      recentChainEvents: recentEvents,
      frontendSnapshot: getFrontendSnapshot(),
      frontendEventRecords: eventRecords
    };

    const filename =
      `HVACAcceptance_D9d8_compatible_export_${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.json`;

    downloadJsonFile(exportData, filename);

    log(
      chainReadStatus.success
        ? "資料已匯出：包含鏈上可讀狀態、近期鏈上事件與前端紀錄。"
        : "資料已匯出：目前未成功同步合約，因此僅包含前端資料與錯誤資訊。",
      "info",
      {
        day: 0,
        category: "system"
      }
    );
  } catch (error) {
    console.error(error);

    log(`下載資料失敗：${typeof getFriendlyError === "function" ? getFriendlyError(error) : error.message}`, "critical", {
      day: 0,
      category: "system"
    });
  } finally {
    updateWriteButtonState();
  }
}

function openEtherscan() {
  window.open(`${ETHERSCAN_BASE_URL}/address/${CONTRACT_ADDRESS}`, "_blank");
}

function initContractAddressUI() {
  const input = document.getElementById("contractAddressInput");
  const box = document.getElementById("contractAddress");

  if (input) {
    input.value = CONTRACT_ADDRESS;
  }

  if (box) {
    box.innerText = CONTRACT_ADDRESS;
  }
}

function isValidEthereumAddress(address) {
  if (typeof ethers !== "undefined" && ethers.isAddress) {
    return ethers.isAddress(address);
  }

  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function detachContractListeners() {
  if (contract && listenersAttached) {
    try {
      contract.removeAllListeners("DataLogged");
      contract.removeAllListeners("ProjectAccepted");
      contract.removeAllListeners("CounterReset");
    } catch (error) {
      console.warn("移除事件監聽失敗：", error);
    }
  }

  listenersAttached = false;
  processedEventKeys = new Set();
}

async function applyCustomContractAddress() {
  const input = document.getElementById("contractAddressInput");

  if (!input) {
    log("找不到合約地址輸入欄位。", "critical", {
      day: 0,
      category: "system"
    });
    return;
  }

  const newAddress = input.value.trim();

  if (!isValidEthereumAddress(newAddress)) {
    log("合約地址格式錯誤，請輸入有效的 0x 開頭 42 碼 Ethereum 地址。", "critical", {
      day: 0,
      category: "system"
    });
    return;
  }

  detachContractListeners();

  CONTRACT_ADDRESS = newAddress;
  localStorage.setItem("HVAC_CONTRACT_ADDRESS", CONTRACT_ADDRESS);

  const box = document.getElementById("contractAddress");

  if (box) {
    box.innerText = CONTRACT_ADDRESS;
  }

  contract = null;
  isAcceptedOnChain = false;

  chainReadCompatibility = {
    targetTempReadable: false,
    targetHumidityReadable: false,
    requiredCountReadable: false,
    consecutiveSuccessesReadable: false,
    isAcceptedReadable: false,
    usingRequiredCountFallback: true,
    usingSuccessCountFallback: true
  };

  log(`已套用新的合約地址：${CONTRACT_ADDRESS}`, "info", {
    day: 0,
    category: "system"
  });

  if (provider && signer) {
    try {
      contract = new ethers.Contract(CONTRACT_ADDRESS, HVAC_ABI, signer);

      await assertContractExists();

      attachContractListeners();
      await syncContractState(false);

      log("新合約地址已連接，並以相容模式完成鏈上狀態同步。", "info", {
        day: 0,
        category: "system"
      });
    } catch (error) {
      console.error(error);

      log(`新合約地址讀取失敗：${getFriendlyError ? getFriendlyError(error) : error.message}`, "critical", {
        day: 0,
        category: "system"
      });
    }
  }

  updateContractSummary();
  updateWriteButtonState();
}

init();