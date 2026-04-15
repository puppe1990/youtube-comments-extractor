const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const core = require("../src/extractor-core");

function createElement(overrides = {}) {
  return {
    href: null,
    id: "",
    innerText: "",
    textContent: "",
    getAttribute() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    ...overrides,
  };
}

function loadContentScript({ video, playButton }) {
  let listener = null;
  const progressMessages = [];
  const sandbox = {
    Array,
    Date,
    Number,
    Promise,
    Set,
    String,
    console,
    globalThis: null,
    location: { href: "https://www.youtube.com/watch?v=test" },
    setTimeout(callback) {
      callback();
      return 0;
    },
    window: {
      scrollTo() {},
    },
    document: {
      title: "Video title",
      documentElement: { scrollHeight: 100 },
      querySelector(selector) {
        if (selector === "video") return video;
        if (selector === ".ytp-play-button[aria-label*='Play']") return playButton;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    chrome: {
      runtime: {
        sendMessage(message) {
          progressMessages.push(message);
        },
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
        },
      },
    },
    YouTubeCommentsExtractorCore: core,
  };
  sandbox.globalThis = sandbox;

  const contentPath = path.join(__dirname, "..", "content.js");
  vm.runInNewContext(fs.readFileSync(contentPath, "utf8"), sandbox);

  return { listener, progressMessages, sandbox };
}

test("content extraction does not autoplay the video", async () => {
  let playCalls = 0;
  let playButtonClicks = 0;
  const video = createElement({
    paused: true,
    play() {
      playCalls++;
      return Promise.resolve();
    },
  });
  const playButton = createElement({
    click() {
      playButtonClicks++;
    },
  });
  const { listener } = loadContentScript({ video, playButton });

  const response = await new Promise((resolve) => {
    listener(
      { type: "YT_COMMENTS_EXTRACT", options: { maxScrollRounds: 1 } },
      {},
      resolve
    );
  });

  assert.equal(response.ok, true);
  assert.equal(playCalls, 0);
  assert.equal(playButtonClicks, 0);
});

test("content extraction reports progress stages", async () => {
  const { listener, progressMessages } = loadContentScript({});

  const response = await new Promise((resolve) => {
    listener(
      { type: "YT_COMMENTS_EXTRACT", options: { maxScrollRounds: 1 } },
      {},
      resolve
    );
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    progressMessages.map((message) => [message.type, message.stage]),
    [
      ["YT_COMMENTS_PROGRESS", "scroll"],
      ["YT_COMMENTS_PROGRESS", "replies"],
      ["YT_COMMENTS_PROGRESS", "collect"],
    ]
  );
});
