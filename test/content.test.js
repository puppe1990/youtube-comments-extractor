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

function createDeferredTimers() {
  const queue = [];

  return {
    setTimeout(callback) {
      queue.push(callback);
      return queue.length;
    },
    async flushNext() {
      if (queue.length > 0) {
        queue.shift()();
      }
      await Promise.resolve();
    },
    async flushAll() {
      for (let cycle = 0; cycle < 25; cycle++) {
        if (queue.length > 0) {
          queue.shift()();
        }
        await Promise.resolve();
      }
    },
  };
}

function loadContentScript({
  video,
  playButton,
  timers,
  commentThreads = [],
  commentsRoot,
  scrollEvents,
} = {}) {
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
    setTimeout: timers?.setTimeout || ((callback) => {
      callback();
      return 0;
    }),
    window: {
      scrollTo() {
        scrollEvents?.push("end-scroll");
      },
    },
    document: {
      title: "Video title",
      documentElement: { scrollHeight: 100 },
      querySelector(selector) {
        if (selector === "video") return video;
        if (selector === ".ytp-play-button[aria-label*='Play']") return playButton;
        if (selector === "ytd-comments#comments, ytd-comments, #comments") return commentsRoot;
        return null;
      },
      querySelectorAll() {
        return typeof commentThreads === "function" ? commentThreads() : commentThreads;
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

function createCommentThreadWithButtons(buttons) {
  return createElement({
    querySelectorAll(selector) {
      if (selector === "ytd-comment-thread-renderer") return [];
      if (selector.includes("#more-replies")) {
        return buttons.filter((button) => button.isMoreRepliesButton);
      }

      const replyMatch = selector.includes("reply");
      const responseMatch = selector.includes("respost");

      return buttons.filter((button) => {
        const label = `${button.innerText || ""} ${button.getAttribute("aria-label") || ""}`
          .toLowerCase();
        return (replyMatch && label.includes("reply")) ||
          (responseMatch && label.includes("respost"));
      });
    },
  });
}

function createStructuredThread({ topNode = null, replyNodes = [] } = {}) {
  return createElement({
    querySelector(selector) {
      if (
        selector === "#comment ytd-comment-view-model" ||
        selector === "#comment ytd-comment-renderer" ||
        selector === "ytd-comment-view-model" ||
        selector === "ytd-comment-renderer"
      ) {
        return topNode;
      }

      return null;
    },
    querySelectorAll(selector) {
      if (selector === "ytd-comment-thread-renderer") return [];
      if (
        selector === "#replies ytd-comment-view-model, #replies ytd-comment-renderer" ||
        selector === "#replies #contents > ytd-comment-view-model, #replies #contents > ytd-comment-renderer, #replies #expanded-threads ytd-comment-view-model, #replies #expanded-threads ytd-comment-renderer"
      ) {
        return replyNodes;
      }
      return [];
    },
  });
}

function createLoadedCommentThread() {
  return createCommentThreadWithButtons([]);
}

function sendContentMessage(listener, message) {
  return new Promise((resolve) => {
    listener(message, {}, resolve);
  });
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
  const { listener } = loadContentScript({
    video,
    playButton,
    commentThreads: [createLoadedCommentThread()],
  });

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
  const { listener, progressMessages } = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 1, runId: "progress-run" },
  });

  assert.equal(response.ok, true);
  const stages = progressMessages.map((message) => message.stage);
  assert.equal(stages[0], "scroll");
  assert.ok(stages.includes("replies"));
  assert.equal(stages.at(-1), "collect");
  assert.ok(stages.indexOf("scroll") < stages.indexOf("replies"));
  assert.ok(stages.indexOf("replies") < stages.indexOf("collect"));
});

test("content extraction exposes running status for a reopened popup", async () => {
  const timers = createDeferredTimers();
  const { listener } = loadContentScript({
    timers,
    commentThreads: [createLoadedCommentThread()],
  });

  const extraction = sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 1, runId: "popup-reopen-run" },
  });

  const status = await sendContentMessage(listener, { type: "YT_COMMENTS_STATUS" });

  assert.equal(status.ok, true);
  assert.equal(status.state.phase, "running");
  assert.equal(status.state.runId, "popup-reopen-run");
  assert.equal(status.state.stage, "scroll");
  assert.equal(status.state.result, null);

  await timers.flushAll();
  await extraction;
});

test("content extraction exposes completed result for a reopened popup", async () => {
  const { listener } = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 1, runId: "finished-run" },
  });
  const status = await sendContentMessage(listener, { type: "YT_COMMENTS_STATUS" });

  assert.equal(response.ok, true);
  assert.equal(status.ok, true);
  assert.equal(status.state.phase, "complete");
  assert.equal(status.state.runId, "finished-run");
  assert.equal(status.state.stage, "complete");
  assert.equal(status.state.result.totalThreads, 1);
  assert.equal(status.state.result.totalReplies, 0);
});

test("content extraction reports how many comments are visible on screen", async () => {
  const topNode = createElement({
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@canal" });
      if (selector === "#content-text") return createElement({ innerText: "Comentario principal" });
      if (selector === "a[href*='lc=']") return createElement({ innerText: "ha 1 dia" });
      if (selector === "#vote-count-middle") return createElement({ innerText: "4" });
      return null;
    },
  });
  const replyNodes = [
    createElement({
      querySelector(selector) {
        if (selector === "#author-text") return createElement({ innerText: "@resposta-1" });
        if (selector === "#content-text") return createElement({ innerText: "Primeira resposta" });
        if (selector === "a[href*='lc=']") return createElement({ innerText: "ha 5 horas" });
        return null;
      },
    }),
    createElement({
      querySelector(selector) {
        if (selector === "#author-text") return createElement({ innerText: "@resposta-2" });
        if (selector === "#content-text") return createElement({ innerText: "Segunda resposta" });
        if (selector === "a[href*='lc=']") return createElement({ innerText: "ha 2 horas" });
        return null;
      },
    }),
  ];
  const { listener } = loadContentScript({
    commentThreads: [createStructuredThread({ topNode, replyNodes })],
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "visible-count-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalThreads, 1);
  assert.equal(response.result.totalReplies, 2);
  assert.equal(response.result.visibleCommentCount, 3);
});

test("content extraction prefers lc query param over generic comment node ids", async () => {
  const topAnchor = createElement({
    innerText: "há 1 dia",
    href: "https://www.youtube.com/watch?v=test&lc=UgwTop123",
  });
  const replyAnchor = createElement({
    innerText: "há 5 horas",
    href: "https://www.youtube.com/watch?v=test&lc=UgwReply456",
  });
  const topNode = createElement({
    id: "comment",
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@canal" });
      if (selector === "#content-text") return createElement({ innerText: "Comentario principal" });
      if (selector === "a[href*='lc=']") return topAnchor;
      if (selector === "#vote-count-middle") return createElement({ innerText: "4" });
      return null;
    },
  });
  const replyNode = createElement({
    id: "comment",
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@resposta-1" });
      if (selector === "#content-text") return createElement({ innerText: "Primeira resposta" });
      if (selector === "a[href*='lc=']") return replyAnchor;
      return null;
    },
  });
  const { listener } = loadContentScript({
    commentThreads: [createStructuredThread({ topNode, replyNodes: [replyNode] })],
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "comment-id-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.data[0].commentId, "UgwTop123");
  assert.equal(response.result.data[0].replies[0].commentId, "UgwReply456");
  assert.equal(response.result.data[0].replies[0].parentCommentId, "UgwTop123");
});

test("content extraction includes debug paths when requested", async () => {
  const topAnchor = createElement({
    innerText: "há 1 dia",
    href: "https://www.youtube.com/watch?v=test&lc=UgwTop123",
  });
  const topNode = createElement({
    tagName: "YTD-COMMENT-VIEW-MODEL",
    id: "comment",
    parentElement: createElement({
      tagName: "DIV",
      parentElement: createElement({
        tagName: "YTD-COMMENT-THREAD-RENDERER",
        parentElement: createElement({ tagName: "DIV" }),
        children: [],
      }),
      children: [],
    }),
    querySelector(selector) {
      if (selector === "#author-text") {
        return createElement({
          innerText: "@canal",
          tagName: "A",
          id: "author-text",
          parentElement: createElement({ tagName: "DIV", children: [] }),
        });
      }
      if (selector === "#content-text") {
        return createElement({
          innerText: "Comentario principal",
          tagName: "YT-ATTRIBUTED-STRING",
          id: "content-text",
          parentElement: createElement({ tagName: "DIV", children: [] }),
        });
      }
      if (selector === "a[href*='lc=']") return topAnchor;
      if (selector === "#vote-count-middle") return createElement({ innerText: "4" });
      return null;
    },
  });
  const thread = createStructuredThread({ topNode, replyNodes: [] });
  thread.tagName = "YTD-COMMENT-THREAD-RENDERER";
  thread.parentElement = createElement({ tagName: "DIV", children: [thread] });
  topNode.parentElement.parentElement = thread;

  const { listener } = loadContentScript({
    commentThreads: [thread],
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "debug-paths-run", includeDebugPaths: true },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(response.result.data[0].debugPaths).sort(), [
    "author",
    "text",
    "thread",
  ]);
});

test("content extraction rejects empty results instead of returning a downloadable JSON", async () => {
  const { listener, sandbox } = loadContentScript({});

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 1, runId: "empty-run" },
  });
  const status = await sendContentMessage(listener, { type: "YT_COMMENTS_STATUS" });

  assert.equal(response.ok, false);
  assert.match(response.error, /Nenhum comentario/i);
  assert.equal(status.state.phase, "error");
  assert.equal(status.state.result, null);
  assert.equal(sandbox.window.__YT_COMMENTS__, undefined);
});

test("content extraction does not click like buttons on replies", async () => {
  let likeClicks = 0;
  let expandClicks = 0;
  let showRepliesButtonVisible = true;
  const likeReplyButton = createElement({
    getAttribute(name) {
      return name === "aria-label" ? "Like this reply" : null;
    },
    click() {
      likeClicks++;
    },
  });
  const showRepliesButton = createElement({
    innerText: "View 3 replies",
    isMoreRepliesButton: true,
    getAttribute(name) {
      return name === "aria-label" ? "View 3 replies" : null;
    },
    click() {
      expandClicks++;
      showRepliesButtonVisible = false;
    },
  });
  const thread = createCommentThreadWithButtons([likeReplyButton, showRepliesButton]);
  const originalQuerySelectorAll = thread.querySelectorAll;
  thread.querySelectorAll = (selector) => {
    const buttons = originalQuerySelectorAll(selector);
    return buttons.filter((button) => button !== showRepliesButton || showRepliesButtonVisible);
  };
  const { listener } = loadContentScript({ commentThreads: [thread] });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "no-like-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(likeClicks, 0);
  assert.equal(expandClicks, 1);
});

test("content extraction clicks sub-thread reply buttons", async () => {
  let expandClicks = 0;
  let subThreadButtonVisible = true;
  const subThreadButton = createElement({
    innerText: "1 resposta",
    isMoreRepliesButton: true,
    getAttribute(name) {
      return name === "aria-label" ? "1 resposta" : null;
    },
    click() {
      expandClicks++;
      subThreadButtonVisible = false;
    },
  });
  const thread = createCommentThreadWithButtons([subThreadButton]);
  const originalQuerySelectorAll = thread.querySelectorAll;
  thread.querySelectorAll = (selector) => {
    const buttons = originalQuerySelectorAll(selector);
    return buttons.filter((button) => button !== subThreadButton || subThreadButtonVisible);
  };
  const { listener } = loadContentScript({ commentThreads: [thread] });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "sub-thread-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(expandClicks, 1);
});

test("content extraction scrolls to comments, primes top-level loading, then expands replies", async () => {
  const scrollEvents = [];
  const commentsRoot = createElement({
    scrollIntoView() {
      scrollEvents.push("comments-section");
    },
  });
  const replyButton = createElement({
    innerText: "View 2 replies",
    isMoreRepliesButton: true,
    getAttribute(name) {
      return name === "aria-label" ? "View 2 replies" : null;
    },
    click() {
      scrollEvents.push("reply-click");
    },
  });
  const thread = createCommentThreadWithButtons([replyButton]);
  const { listener } = loadContentScript({
    commentThreads: [thread],
    commentsRoot,
    scrollEvents,
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "ordered-load-run" },
  });

  const commentsSectionIndex = scrollEvents.indexOf("comments-section");
  const firstEndScrollIndex = scrollEvents.indexOf("end-scroll");
  const replyClickIndex = scrollEvents.indexOf("reply-click");

  assert.equal(response.ok, true);
  assert.notEqual(commentsSectionIndex, -1);
  assert.notEqual(firstEndScrollIndex, -1);
  assert.notEqual(replyClickIndex, -1);
  assert.ok(commentsSectionIndex < firstEndScrollIndex);
  assert.ok(firstEndScrollIndex < replyClickIndex);
  assert.equal(
    scrollEvents.slice(0, replyClickIndex).filter((event) => event === "end-scroll").length,
    3
  );
});

test("content extraction can skip replies stage and continue collecting", async () => {
  const timers = createDeferredTimers();
  let showRepliesButtonVisible = true;
  let replyClicks = 0;
  const replyButton = createElement({
    innerText: "7 respostas",
    isMoreRepliesButton: true,
    getAttribute(name) {
      return name === "aria-label" ? "7 respostas" : null;
    },
    click() {
      replyClicks++;
      showRepliesButtonVisible = false;
    },
  });
  const thread = createCommentThreadWithButtons([replyButton]);
  const originalQuerySelectorAll = thread.querySelectorAll;
  thread.querySelectorAll = (selector) => {
    const buttons = originalQuerySelectorAll(selector);
    return buttons.filter((button) => button !== replyButton || showRepliesButtonVisible);
  };

  const { listener } = loadContentScript({
    timers,
    commentThreads: [thread],
  });

  const extraction = sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "skip-replies-run" },
  });

  for (let index = 0; index < 10; index++) {
    await timers.flushNext();
    const status = await sendContentMessage(listener, { type: "YT_COMMENTS_STATUS" });
    if (status.state.stage === "replies") break;
  }

  const skipResponse = await sendContentMessage(listener, {
    type: "YT_COMMENTS_SKIP_STEP",
  });
  await timers.flushAll();
  const response = await extraction;

  assert.equal(skipResponse.ok, true);
  assert.equal(skipResponse.skippedStage, "replies");
  assert.equal(response.ok, true);
  assert.equal(replyClicks, 1);
});
