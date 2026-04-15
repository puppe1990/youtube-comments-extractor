const extractButton = document.querySelector("#extractButton");
const statusOutput = document.querySelector("#status");
const maxScrollRoundsInput = document.querySelector("#maxScrollRounds");
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

const progressState = {
  activeStep: null,
  completedSteps: new Set(),
  failedStep: null,
};

function setStatus(message, tone = "idle") {
  statusOutput.textContent = message;
  statusOutput.dataset.tone = tone;
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
  progressState.activeStep = null;
  progressState.completedSteps = new Set();
  progressState.failedStep = null;
  progressEyebrow.textContent = "Status";
  progressTitle.textContent = "Preparando...";
  commentsMetric.textContent = "0";
  repliesMetric.textContent = "0";
  setStatus("Iniciando coleta no YouTube...", "working");
  updateProgressView();
}

function startStep(stepId, message) {
  progressState.activeStep = stepId;
  progressTitle.textContent = message;
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
  setStatus(message, "error");
  updateProgressView();
}

function completeAllSteps() {
  for (const step of STEP_DEFINITIONS) {
    progressState.completedSteps.add(step.id);
  }
  progressState.activeStep = null;
  progressState.failedStep = null;
  updateProgressView();
}

function handleProgressMessage(message) {
  if (message?.type !== "YT_COMMENTS_PROGRESS" || message.runId !== currentRunId) {
    return;
  }

  if (message.stage === "scroll") {
    completeStep("connect");
    startStep("scroll", "Carregando comentarios");
    commentsMetric.textContent = String(message.commentsSeen || 0);
    const round = message.round ? `Rodada ${message.round}/${message.maxRounds}. ` : "";
    setStatus(`${round}${message.commentsSeen || 0} comentarios encontrados ate agora.`, "working");
  }

  if (message.stage === "replies") {
    completeStep("scroll");
    startStep("replies", "Expandindo respostas");
    const pass = message.pass ? `Passagem ${message.pass}/${message.maxPasses}. ` : "";
    setStatus(`${pass}Abrindo respostas disponiveis.`, "working");
  }

  if (message.stage === "collect") {
    completeStep("replies");
    startStep("collect", "Organizando JSON");
    setStatus("Lendo comentarios carregados e montando o arquivo.", "working");
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
  anchor.download = `${safeFileName(result.title)}-${Date.now()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendExtractionMessage(tabId, maxScrollRounds) {
  const message = {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds, runId: currentRunId },
  };

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

renderSteps();
chrome.runtime.onMessage.addListener(handleProgressMessage);

extractButton.addEventListener("click", async () => {
  extractButton.disabled = true;
  currentRunId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  resetProgress();
  startStep("validate", "Validando video");

  try {
    const tab = await getActiveTab();

    if (!tab?.id || !/^https:\/\/(www|m)\.youtube\.com\/watch/.test(tab.url || "")) {
      throw new Error("Abra uma pagina de video do YouTube antes de extrair.");
    }

    completeStep("validate");
    startStep("connect", "Conectando ao YouTube");

    const maxScrollRounds = Number(maxScrollRoundsInput.value || 30);
    const response = await sendExtractionMessage(tab.id, maxScrollRounds);

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
    setStatus(
      `JSON baixado.\nComentarios: ${response.result.totalThreads}\nRespostas: ${response.result.totalReplies}`,
      "success"
    );
  } catch (error) {
    failCurrentStep(error?.message || String(error));
  } finally {
    extractButton.disabled = false;
  }
});
