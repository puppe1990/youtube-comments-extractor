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

function createPopupHarness({ initialStatus } = {}) {
  const nodes = {
    "#extractButton": createNode(),
    "#skipStepButton": createNode({ textContent: "Pular etapa", disabled: true }),
    "#status": createNode(),
    "#maxScrollRounds": createNode({ value: "30" }),
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
        async executeScript() {},
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
