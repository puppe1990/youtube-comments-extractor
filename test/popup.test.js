const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createNode(overrides = {}) {
  return {
    textContent: "",
    innerHTML: "",
    value: "",
    disabled: false,
    dataset: {},
    children: [],
    listeners: {},
    append(child) {
      this.children.push(child);
    },
    remove() {},
    click() {
      return this.listeners.click?.({ currentTarget: this });
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    querySelectorAll() {
      return [];
    },
    ...overrides,
  };
}

function createPopupHarness({ initialStatus, apiContext } = {}) {
  const nodes = {
    "#extractButton": createNode(),
    "#resetButton": createNode({ textContent: "Reiniciar" }),
    "#skipStepButton": createNode({ textContent: "Pular etapa", disabled: true }),
    "#debugPaths": createNode({ checked: false }),
    "#status": createNode(),
    "#maxScrollRounds": createNode({ value: "12" }),
    "#extractionMode": createNode({ value: "dom" }),
    "#progressEyebrow": createNode(),
    "#progressTitle": createNode(),
    "#progressSteps": createNode({
      querySelectorAll() {
        return [];
      },
    }),
    "#commentsMetric": createNode(),
    "#repliesMetric": createNode(),
  };

  const runtimeListeners = [];
  const sentMessages = [];
  const scriptingCalls = [];

  const sandbox = {
    Blob: class Blob {
      constructor(parts, options) {
        this.parts = parts;
        this.options = options;
      }
    },
    URL: {
      createObjectURL() {
        return "blob:test";
      },
      revokeObjectURL() {},
    },
    Math,
    Date,
    Promise,
    String,
    Number,
    Set,
    console,
    globalThis: null,
    document: {
      body: createNode(),
      querySelector(selector) {
        return nodes[selector] || null;
      },
      createElement() {
        return createNode();
      },
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            runtimeListeners.push(listener);
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 1, url: "https://www.youtube.com/watch?v=test" }];
        },
        async sendMessage(_tabId, message) {
          sentMessages.push(message);
          if (message.type === "YT_COMMENTS_STATUS") {
            return { ok: true, state: initialStatus || { phase: "idle" } };
          }
          return { ok: true };
        },
      },
      scripting: {
        async executeScript(injection) {
          scriptingCalls.push(injection);
          return apiContext ? [{ result: apiContext }] : [];
        },
      },
    },
  };
  sandbox.globalThis = sandbox;

  const popupPath = path.join(__dirname, "..", "popup.js");
  vm.runInNewContext(fs.readFileSync(popupPath, "utf8"), sandbox);

  return {
    nodes,
    sentMessages,
    runtimeListeners,
    sandbox,
    scriptingCalls,
    async settle() {
      if (typeof sandbox.restoreStateFromActiveTab === "function") {
        await sandbox.restoreStateFromActiveTab();
      }
      for (let index = 0; index < 5; index++) {
        await Promise.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test("popup enables skip button while replies stage is active", async () => {
  const { nodes, sandbox } = createPopupHarness();
  sandbox.applySavedExtractionState({
    phase: "running",
    runId: "run-1",
    stage: "replies",
    commentsSeen: 10,
    visibleCommentCount: 12,
    result: null,
    error: null,
  });

  assert.equal(nodes["#skipStepButton"].disabled, false);
  assert.equal(nodes["#skipStepButton"].textContent, "Pular etapa");
});

test("popup sends manual skip command for replies stage", async () => {
  const { nodes, sentMessages, sandbox } = createPopupHarness();
  sandbox.applySavedExtractionState({
    phase: "running",
    runId: "run-2",
    stage: "replies",
    commentsSeen: 10,
    visibleCommentCount: 12,
    result: null,
    error: null,
  });
  await nodes["#skipStepButton"].click();

  assert.ok(sentMessages.some((message) => message.type === "YT_COMMENTS_SKIP_STEP"));
});

test("popup includes debug paths option when extraction starts", async () => {
  const { nodes, sentMessages } = createPopupHarness();
  nodes["#debugPaths"].checked = true;

  await nodes["#extractButton"].click();

  const extractMessage = sentMessages.find((message) => message.type === "YT_COMMENTS_EXTRACT");
  assert.equal(extractMessage.options.includeDebugPaths, true);
});

test("popup uses a lower default scroll round count", async () => {
  const { nodes, sentMessages } = createPopupHarness();
  nodes["#maxScrollRounds"].value = "";

  await nodes["#extractButton"].click();

  const extractMessage = sentMessages.find((message) => message.type === "YT_COMMENTS_EXTRACT");
  assert.equal(extractMessage.options.maxScrollRounds, 12);
});

test("popup reset clears UI state and sends reset command", async () => {
  const { nodes, sentMessages, sandbox } = createPopupHarness();

  sandbox.applySavedExtractionState({
    phase: "complete",
    runId: "run-reset",
    stage: "complete",
    commentsSeen: 25,
    visibleCommentCount: 30,
    result: { totalThreads: 20, totalReplies: 10 },
    error: null,
  });

  await nodes["#resetButton"].click();

  assert.ok(sentMessages.some((message) => message.type === "YT_COMMENTS_RESET"));
  assert.equal(nodes["#extractButton"].textContent, "Extrair e baixar JSON");
  assert.equal(nodes["#commentsMetric"].textContent, "0");
  assert.equal(nodes["#repliesMetric"].textContent, "0");
  assert.equal(nodes["#progressTitle"].textContent, "Pronto.");
  assert.equal(nodes["#status"].textContent, "Aguardando video do YouTube.");
});

test("popup extracts through the DOM by default", async () => {
  const { nodes, sentMessages, scriptingCalls } = createPopupHarness();

  await nodes["#extractButton"].click();

  const extractMessage = sentMessages.find((message) => message.type === "YT_COMMENTS_EXTRACT");
  assert.equal(extractMessage.options.mode, "dom");
  assert.equal(extractMessage.options.api, null);
  assert.equal(scriptingCalls.length, 0);
});

test("popup reads the page context and forwards the API mode", async () => {
  const apiContext = { continuationToken: "PAGE_TOKEN", context: { client: { clientName: "WEB" } } };
  const { nodes, sentMessages, scriptingCalls } = createPopupHarness({ apiContext });
  nodes["#extractionMode"].value = "api";

  await nodes["#extractButton"].click();

  const extractMessage = sentMessages.find((message) => message.type === "YT_COMMENTS_EXTRACT");
  assert.equal(extractMessage.options.mode, "api");
  assert.equal(extractMessage.options.api.continuationToken, "PAGE_TOKEN");
  assert.deepEqual(
    scriptingCalls.map((injection) => injection.world),
    ["MAIN", "MAIN"]
  );
  assert.deepEqual(Array.from(scriptingCalls[0].files), ["src/extractor-core.js"]);
});
