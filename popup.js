const extractButton = document.querySelector("#extractButton");
const skipStepButton = document.querySelector("#skipStepButton");
const resetButton = document.querySelector("#resetButton");
const statusOutput = document.querySelector("#status");
const maxScrollRoundsInput = document.querySelector("#maxScrollRounds");
const debugPathsInput = document.querySelector("#debugPaths");
const modeSelect = document.querySelector("#extractionMode");
const progressEyebrow = document.querySelector("#progressEyebrow");
const progressTitle = document.querySelector("#progressTitle");
const progressSteps = document.querySelector("#progressSteps");
const commentsMetric = document.querySelector("#commentsMetric");
const repliesMetric = document.querySelector("#repliesMetric");

const STEP_DEFINITIONS = [
  { id: "validate", label: "Validando video" },
  { id: "connect", label: "Conectando ao YouTube" },
  { id: "scroll", label: "Carregando comentarios" },
  { id: "replies", label: "Expandindo respostas" },
  { id: "collect", label: "Organizando JSON" },
  { id: "download", label: "Baixando arquivo" },
];

let currentRunId = null;
let savedResultForDownload = null;

const progressState = {
  activeStep: null,
  completedSteps: new Set(),
  failedStep: null,
};

function setSkipStepButton(enabled = false) {
  skipStepButton.disabled = !enabled;
}

function setStatus(message, tone = "idle") {
  statusOutput.textContent = message;
  statusOutput.dataset.tone = tone;
}

function setExtractButton(label, disabled = false) {
  extractButton.textContent = label;
  extractButton.disabled = disabled;
}

function renderSteps() {
  progressSteps.innerHTML = STEP_DEFINITIONS.map(
    (step) => `
      <li class="progress-step" data-step="${step.id}" data-state="pending">
        <span class="step-icon" aria-hidden="true"></span>
        <span>${step.label}</span>
      </li>
    `
  ).join("");
}

function updateProgressView() {
  for (const step of progressSteps.querySelectorAll(".progress-step")) {
    const stepId = step.dataset.step;
    let state = "pending";

    if (progressState.failedStep === stepId) {
      state = "error";
    } else if (progressState.activeStep === stepId) {
      state = "active";
    } else if (progressState.completedSteps.has(stepId)) {
      state = "done";
    }

    step.dataset.state = state;
  }
}

function resetProgress() {
  savedResultForDownload = null;
  progressState.activeStep = null;
  progressState.completedSteps = new Set();
  progressState.failedStep = null;
  progressEyebrow.textContent = "Status";
  progressTitle.textContent = "Preparando...";
  commentsMetric.textContent = "0";
  repliesMetric.textContent = "0";
  setSkipStepButton(false);
  setExtractButton("Extrair e baixar JSON", true);
  setStatus("Iniciando coleta no YouTube...", "working");
  updateProgressView();
}

function resetToInitialState() {
  currentRunId = null;
  savedResultForDownload = null;
  progressState.activeStep = null;
  progressState.completedSteps = new Set();
  progressState.failedStep = null;
  progressEyebrow.textContent = "Status";
  progressTitle.textContent = "Pronto.";
  commentsMetric.textContent = "0";
  repliesMetric.textContent = "0";
  setSkipStepButton(false);
  setExtractButton("Extrair e baixar JSON", false);
  setStatus("Aguardando video do YouTube.", "idle");
  updateProgressView();
}

function startStep(stepId, message) {
  progressState.activeStep = stepId;
  progressTitle.textContent = message;
  setSkipStepButton(stepId === "replies");
  updateProgressView();
}

function completeStep(stepId) {
  progressState.completedSteps.add(stepId);
  if (progressState.activeStep === stepId) {
    progressState.activeStep = null;
  }
  updateProgressView();
}

function failCurrentStep(message) {
  progressState.failedStep = progressState.activeStep || "validate";
  progressEyebrow.textContent = "Erro";
  progressTitle.textContent = "A coleta parou";
  setSkipStepButton(false);
  setStatus(message, "error");
  updateProgressView();
}

function completeAllSteps() {
  for (const step of STEP_DEFINITIONS) {
    progressState.completedSteps.add(step.id);
  }
  progressState.activeStep = null;
  progressState.failedStep = null;
  setSkipStepButton(false);
  updateProgressView();
}

function completeCollectionSteps() {
  progressState.completedSteps = new Set(["validate", "connect", "scroll", "replies", "collect"]);
  progressState.activeStep = null;
  progressState.failedStep = null;
  setSkipStepButton(false);
  updateProgressView();
}

function restoreProgressFromStage(stage) {
  const stageIndex = STEP_DEFINITIONS.findIndex((step) => step.id === stage);
  progressState.completedSteps = new Set(["validate", "connect"]);
  progressState.failedStep = null;

  for (let index = 0; index < stageIndex; index++) {
    progressState.completedSteps.add(STEP_DEFINITIONS[index].id);
  }

  progressState.activeStep = stageIndex >= 0 ? stage : "scroll";
  setSkipStepButton(progressState.activeStep === "replies");
  updateProgressView();
}

function getStageTitle(stage) {
  return {
    scroll: "Carregando comentarios",
    replies: "Expandindo respostas",
    collect: "Organizando JSON",
    download: "Baixando arquivo",
  }[stage] || "Extraindo comentarios";
}

function getModeLabel(mode) {
  return mode === "api" ? " (via API interna)" : " (via crawler DOM)";
}

function formatExtractionSummary(visibleCommentCount, extractedCommentCount, expectedCommentCount) {
  if (!visibleCommentCount && !extractedCommentCount && !expectedCommentCount) {
    return "";
  }

  const lines = [];

  if (typeof visibleCommentCount === "number") {
    lines.push(`Na tela: ${visibleCommentCount}`);
  }

  lines.push(`Extraidos: ${extractedCommentCount || 0}`);

  if (expectedCommentCount) {
    lines.push(`Esperados no YouTube: ${expectedCommentCount}`);
  }

  return lines.join("\n");
}

function applySavedExtractionState(state) {
  if (!state || state.phase === "idle") {
    setExtractButton("Extrair e baixar JSON", false);
    return;
  }

  currentRunId = state.runId || currentRunId;

  if (state.phase === "running") {
    savedResultForDownload = null;
    progressEyebrow.textContent = "Status";
    progressTitle.textContent = getStageTitle(state.stage);
    commentsMetric.textContent = String(state.commentsSeen || 0);
    repliesMetric.textContent = "0";
    restoreProgressFromStage(state.stage);
    const visibleCommentCount = state.visibleCommentCount || 0;
    const statusSummary = formatExtractionSummary(
      visibleCommentCount,
      visibleCommentCount,
      state.expectedCommentCount
    );
    setStatus(
      `Coleta em andamento nesta aba. Mantenha o video aberto.${statusSummary ? `\n${statusSummary}` : ""}`,
      "working"
    );
    setExtractButton("Extraindo...", true);
    return;
  }

  if (state.phase === "complete" && state.result) {
    savedResultForDownload = state.result;
    completeCollectionSteps();
    progressEyebrow.textContent = "Concluido";
    progressTitle.textContent = "JSON pronto";
    commentsMetric.textContent = String(state.result.totalThreads);
    repliesMetric.textContent = String(state.result.totalReplies);
    const extractedCommentCount = state.result.totalThreads + state.result.totalReplies;
    const statusSummary = formatExtractionSummary(
      state.result.visibleCommentCount,
      extractedCommentCount,
      state.result.expectedCommentCount
    );
    setStatus(
      `Coleta concluida${getModeLabel(state.result.mode)}.\nComentarios: ${state.result.totalThreads}\nRespostas: ${state.result.totalReplies}${statusSummary ? `\n${statusSummary}` : ""}`,
      "success"
    );
    setExtractButton("Baixar JSON", false);
    return;
  }

  if (state.phase === "error") {
    savedResultForDownload = null;
    restoreProgressFromStage(state.stage);
    failCurrentStep(state.error || "Nao foi possivel concluir a coleta.");
    setExtractButton("Extrair novamente", false);
  }
}

function handleProgressMessage(message) {
  if (message?.type !== "YT_COMMENTS_PROGRESS" || message.runId !== currentRunId) {
    return;
  }

  if (message.stage === "scroll" && message.source === "api") {
    completeStep("connect");
    startStep("scroll", "Buscando comentarios via API");

    if (message.fallback) {
      setStatus("API interna indisponivel. Voltando para a coleta via DOM...", "working");
      return;
    }

    const page = message.round ? `Pagina ${message.round}. ` : "";
    commentsMetric.textContent = String(message.commentsSeen || 0);
    setStatus(`${page}${message.commentsSeen || 0} comentarios lidos via API interna.`, "working");
    return;
  }

  if (message.stage === "replies" && message.source === "api") {
    completeStep("scroll");
    startStep("replies", "Carregando respostas via API");
    setStatus(`Respostas carregadas via API interna: ${message.repliesLoaded || 0}.`, "working");
    return;
  }

  if (message.stage === "scroll") {
    completeStep("connect");
    startStep("scroll", "Carregando comentarios");
    commentsMetric.textContent = String(message.commentsSeen || 0);
    const round = message.round ? `Rodada ${message.round}/${message.maxRounds}. ` : "";
    const visibleCommentCount = message.visibleCommentCount || message.commentsSeen || 0;
    const foundCommentCount = message.commentsSeen || 0;
    const foundLabel = message.expectedCommentCount
      ? `${foundCommentCount} de ${message.expectedCommentCount}`
      : String(foundCommentCount);
    setStatus(
      `${round}${foundLabel} comentarios principais encontrados ate agora.\n${formatExtractionSummary(visibleCommentCount, visibleCommentCount, message.expectedCommentCount)}`,
      "working"
    );
  }

  if (message.stage === "collect" && message.source === "api") {
    completeStep("replies");
    startStep("collect", "Organizando JSON");
    setStatus(
      `${message.commentsSeen || 0} comentarios recebidos da API interna. Montando o arquivo.`,
      "working"
    );
    return;
  }

  if (message.stage === "replies") {
    completeStep("scroll");
    startStep("replies", "Expandindo respostas");
    const pass = message.pass ? `Passagem ${message.pass}/${message.maxPasses}. ` : "";
    const visibleCommentCount = message.visibleCommentCount || 0;
    setStatus(
      `${pass}Abrindo respostas disponiveis.\n${formatExtractionSummary(visibleCommentCount, visibleCommentCount, message.expectedCommentCount)}`,
      "working"
    );
  }

  if (message.stage === "collect") {
    completeStep("replies");
    startStep("collect", "Organizando JSON");
    const visibleCommentCount = message.visibleCommentCount || 0;
    setStatus(
      `Lendo comentarios carregados e montando o arquivo.\n${formatExtractionSummary(visibleCommentCount, visibleCommentCount, message.expectedCommentCount)}`,
      "working"
    );
  }
}

function safeFileName(value) {
  return String(value || "youtube-comments")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .toLowerCase();
}

function downloadJson(result) {
  const blob = new Blob([JSON.stringify(result, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(result.title)}-${result.mode || "json"}-${Date.now()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const missingReceiver = error?.message?.includes("Receiving end does not exist");
    if (!missingReceiver) throw error;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/extractor-core.js", "content.js"],
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

function getExtractionMode() {
  return modeSelect?.value === "api" ? "api" : "dom";
}

function readPageApiContextInPage() {
  const core = globalThis.YouTubeCommentsExtractorCore;
  const panelSelector =
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-comments-section']";
  const sources = [
    globalThis.ytInitialData,
    document.querySelector("ytd-comments")?.data,
    document.querySelector(`${panelSelector} ytd-comments`)?.data,
  ];
  const ytcfg = globalThis.ytcfg;

  return {
    clientName: ytcfg?.get?.("INNERTUBE_CLIENT_NAME") || null,
    clientVersion: ytcfg?.get?.("INNERTUBE_CLIENT_VERSION") || null,
    context: ytcfg?.get?.("INNERTUBE_CONTEXT") || null,
    continuationToken:
      sources.map((data) => core?.findCommentsContinuationToken?.(data) || null).find(Boolean) ||
      null,
  };
}

async function readPageApiContext(tabId) {
  if (!tabId) return null;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["src/extractor-core.js"],
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readPageApiContextInPage,
    });

    return (Array.isArray(results) ? results[0]?.result : null) || null;
  } catch {
    return null;
  }
}

async function sendExtractionMessage(tabId, maxScrollRounds, includeDebugPaths, extra = {}) {
  return sendTabMessage(tabId, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds, runId: currentRunId, includeDebugPaths, ...extra },
  });
}

async function sendSkipStepMessage(tabId) {
  return sendTabMessage(tabId, {
    type: "YT_COMMENTS_SKIP_STEP",
  });
}

async function sendResetMessage(tabId) {
  return sendTabMessage(tabId, {
    type: "YT_COMMENTS_RESET",
  });
}

async function restoreStateFromActiveTab() {
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !/^https:\/\/(www|m)\.youtube\.com\/watch/.test(tab.url || "")) {
      setExtractButton("Extrair e baixar JSON", false);
      return;
    }

    const response = await sendTabMessage(tab.id, { type: "YT_COMMENTS_STATUS" });
    if (response?.ok) {
      applySavedExtractionState(response.state);
    }
  } catch {
    setExtractButton("Extrair e baixar JSON", false);
  }
}

renderSteps();
chrome.runtime.onMessage.addListener(handleProgressMessage);
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "YT_COMMENTS_PAGE_CONTEXT") return false;

  getActiveTab()
    .then((tab) => readPageApiContext(tab?.id))
    .then((api) => sendResponse({ ok: Boolean(api), api }))
    .catch(() => sendResponse({ ok: false, api: null }));

  return true;
});
resetToInitialState();
restoreStateFromActiveTab();

extractButton.addEventListener("click", async () => {
  if (savedResultForDownload) {
    downloadJson(savedResultForDownload);
    completeAllSteps();
    progressEyebrow.textContent = "Concluido";
    progressTitle.textContent = "JSON baixado";
    setStatus("JSON baixado novamente.", "success");
    return;
  }

  extractButton.disabled = true;
  currentRunId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  resetProgress();
  setExtractButton("Extraindo...", true);
  startStep("validate", "Validando video");

  try {
    const tab = await getActiveTab();

    if (!tab?.id || !/^https:\/\/(www|m)\.youtube\.com\/watch/.test(tab.url || "")) {
      throw new Error("Abra uma pagina de video do YouTube antes de extrair.");
    }

    completeStep("validate");
    startStep("connect", "Conectando ao YouTube");

    const maxScrollRounds = Number(maxScrollRoundsInput.value || 12);
    const includeDebugPaths = Boolean(debugPathsInput?.checked);
    const mode = getExtractionMode();
    const apiContext = mode === "api" ? await readPageApiContext(tab.id) : null;
    const response = await sendExtractionMessage(tab.id, maxScrollRounds, includeDebugPaths, {
      mode,
      api: apiContext,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Nao foi possivel extrair os comentarios.");
    }

    completeStep("collect");
    startStep("download", "Baixando arquivo");
    downloadJson(response.result);
    completeAllSteps();
    progressEyebrow.textContent = "Concluido";
    progressTitle.textContent = "JSON baixado";
    commentsMetric.textContent = String(response.result.totalThreads);
    repliesMetric.textContent = String(response.result.totalReplies);
    savedResultForDownload = response.result;
    const extractedCommentCount = response.result.totalThreads + response.result.totalReplies;
    const statusSummary = formatExtractionSummary(
      response.result.visibleCommentCount,
      extractedCommentCount,
      response.result.expectedCommentCount
    );
    setStatus(
      `JSON baixado${getModeLabel(response.result.mode)}.\nComentarios: ${response.result.totalThreads}\nRespostas: ${response.result.totalReplies}${statusSummary ? `\n${statusSummary}` : ""}`,
      "success"
    );
    setExtractButton("Baixar JSON", false);
  } catch (error) {
    failCurrentStep(error?.message || String(error));
    setExtractButton("Extrair novamente", false);
  } finally {
    if (!savedResultForDownload && extractButton.textContent === "Extraindo...") {
      setExtractButton("Extrair e baixar JSON", false);
    }
  }
});

skipStepButton.addEventListener("click", async () => {
  if (skipStepButton.disabled || progressState.activeStep !== "replies") return;

  skipStepButton.disabled = true;

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error("Nao foi possivel encontrar a aba ativa.");
    }

    const response = await sendSkipStepMessage(tab.id);
    if (!response?.ok) {
      throw new Error(response?.error || "Nao foi possivel pular a etapa atual.");
    }

    completeStep("replies");
    startStep("collect", "Organizando JSON");
    setStatus("Etapa de respostas pulada manualmente. Organizando JSON carregado.", "working");
  } catch (error) {
    setSkipStepButton(progressState.activeStep === "replies");
    setStatus(error?.message || String(error), "error");
  }
});

resetButton?.addEventListener("click", async () => {
  resetToInitialState();

  try {
    const tab = await getActiveTab();
    if (!tab?.id || !/^https:\/\/(www|m)\.youtube\.com\/watch/.test(tab.url || "")) {
      return;
    }

    await sendResetMessage(tab.id);
  } catch {
    // Keep popup reset even if the content script is unavailable.
  }
});
