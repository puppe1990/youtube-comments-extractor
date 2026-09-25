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
      let idleCycles = 0;

      for (let cycle = 0; cycle < 500 && idleCycles < 20; cycle++) {
        if (queue.length > 0) {
          queue.shift()();
          idleCycles = 0;
        } else {
          idleCycles++;
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
  commentsPanel,
  commentsHeader,
  pageChannelId,
  quickActionButtons = [],
  fetchImpl,
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
    TextEncoder,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    console,
    fetch: fetchImpl,
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
        if (selector === "ytd-comments#comments, ytd-comments, ytm-comments, #comments") {
          return commentsRoot;
        }
        if (
          selector ===
          "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-comments-section']"
        ) {
          return commentsPanel;
        }
        if (selector === "ytd-comments-header-renderer") return commentsHeader;
        if (selector === 'meta[itemprop="channelId"]') {
          return pageChannelId ? createElement({ content: pageChannelId }) : null;
        }
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "button") return quickActionButtons;
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

test("content reset clears state and cancels in-flight extraction", async () => {
  const timers = createDeferredTimers();
  const { listener, sandbox } = loadContentScript({
    timers,
    commentThreads: [createLoadedCommentThread()],
  });

  const extraction = sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 1, runId: "reset-run" },
  });

  await timers.flushNext();
  const resetResponse = await sendContentMessage(listener, { type: "YT_COMMENTS_RESET" });
  const status = await sendContentMessage(listener, { type: "YT_COMMENTS_STATUS" });
  await timers.flushAll();
  const extractionResponse = await extraction;

  assert.equal(resetResponse.ok, true);
  assert.equal(status.state.phase, "idle");
  assert.equal(status.state.runId, null);
  assert.equal(status.state.result, null);
  assert.equal(sandbox.window.__YT_COMMENTS__, undefined);
  assert.equal(extractionResponse.ok, false);
  assert.match(extractionResponse.error, /cancelada|reiniciada/i);
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

test("content extraction deduplicates repeated reply nodes by comment id within the same thread", async () => {
  const topAnchor = createElement({
    innerText: "há 1 dia",
    href: "https://www.youtube.com/watch?v=test&lc=UgwTop123",
  });
  const duplicateReplyAnchor = createElement({
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
  const duplicateReplyNodeA = createElement({
    id: "comment",
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@resposta-1" });
      if (selector === "#content-text") return createElement({ innerText: "Primeira resposta" });
      if (selector === "a[href*='lc=']") return duplicateReplyAnchor;
      return null;
    },
  });
  const duplicateReplyNodeB = createElement({
    id: "comment",
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@resposta-1" });
      if (selector === "#content-text") return createElement({ innerText: "Primeira resposta" });
      if (selector === "a[href*='lc=']") return duplicateReplyAnchor;
      return null;
    },
  });
  const { listener } = loadContentScript({
    commentThreads: [
      createStructuredThread({
        topNode,
        replyNodes: [duplicateReplyNodeA, duplicateReplyNodeB],
      }),
    ],
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "dedupe-replies-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalReplies, 1);
  assert.equal(response.result.data[0].repliesCount, 1);
  assert.equal(response.result.data[0].replies[0].commentId, "UgwReply456");
});

test("content extraction refreshes live threads before collecting the final JSON", async () => {
  const topAnchorA = createElement({
    innerText: "há 1 dia",
    href: "https://www.youtube.com/watch?v=test&lc=UgwTopA",
  });
  const topAnchorB = createElement({
    innerText: "há 30 minutos",
    href: "https://www.youtube.com/watch?v=test&lc=UgwTopB",
  });
  const topNodeA = createElement({
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@autor-a" });
      if (selector === "#content-text") return createElement({ innerText: "Comentario A" });
      if (selector === "a[href*='lc=']") return topAnchorA;
      return null;
    },
  });
  const topNodeB = createElement({
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@autor-b" });
      if (selector === "#content-text") return createElement({ innerText: "Comentario B" });
      if (selector === "a[href*='lc=']") return topAnchorB;
      return null;
    },
  });
  const threadA = createStructuredThread({ topNode: topNodeA });
  const threadB = createStructuredThread({ topNode: topNodeB });
  let threadQueryCount = 0;

  const { listener } = loadContentScript({
    commentThreads() {
      threadQueryCount += 1;
      return threadQueryCount === 1 ? [threadA] : [threadA, threadB];
    },
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "refresh-live-threads-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalThreads, 2);
  assert.deepEqual(
    Array.from(response.result.data, (comment) => comment.commentId),
    ["UgwTopA", "UgwTopB"]
  );
});

test("content extraction ignores nested thread renderers that live inside replies", async () => {
  const topAnchor = createElement({
    innerText: "há 1 dia",
    href: "https://www.youtube.com/watch?v=test&lc=UgwTop123",
  });
  const nestedReplyAnchor = createElement({
    innerText: "há 10 minutos",
    href: "https://www.youtube.com/watch?v=test&lc=UgwTop123.AReply456",
  });
  const topNode = createElement({
    closest(selector) {
      if (selector === "#replies, ytd-comment-replies-renderer") return null;
      return null;
    },
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@autor-topo" });
      if (selector === "#content-text") return createElement({ innerText: "Comentario topo" });
      if (selector === "a[href*='lc=']") return topAnchor;
      return null;
    },
  });
  const nestedReplyTopNode = createElement({
    closest(selector) {
      if (selector === "#replies, ytd-comment-replies-renderer") {
        return createElement({ id: "replies" });
      }
      return null;
    },
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@autor-reply" });
      if (selector === "#content-text") return createElement({ innerText: "Reply promovida por engano" });
      if (selector === "a[href*='lc=']") return nestedReplyAnchor;
      return null;
    },
  });
  const topThread = createStructuredThread({ topNode });
  const nestedThread = createStructuredThread({ topNode: nestedReplyTopNode });
  topThread.closest = () => null;
  nestedThread.closest = () => createElement({ id: "replies" });

  const { listener } = loadContentScript({
    commentThreads: [topThread, nestedThread],
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "ignore-nested-thread-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalThreads, 1);
  assert.deepEqual(Array.from(response.result.data, (comment) => comment.commentId), [
    "UgwTop123",
  ]);
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

test("content extraction ignores hidden reply buttons and clicks only visible ones", async () => {
  let hiddenClicks = 0;
  let visibleClicks = 0;
  const hiddenButton = createElement({
    hidden: true,
    innerText: "7 respostas",
    isMoreRepliesButton: true,
    getAttribute(name) {
      if (name === "aria-label") return "7 respostas";
      if (name === "hidden") return "";
      return null;
    },
    click() {
      hiddenClicks++;
    },
  });
  let visibleLabel = "7 respostas";
  const visibleButton = createElement({
    isMoreRepliesButton: true,
    getAttribute(name) {
      return name === "aria-label" ? visibleLabel : null;
    },
    click() {
      visibleClicks++;
      visibleLabel = "Ocultar respostas";
    },
  });

  Object.defineProperty(visibleButton, "innerText", { get: () => visibleLabel });

  const thread = createCommentThreadWithButtons([hiddenButton, visibleButton]);
  const { listener } = loadContentScript({ commentThreads: [thread] });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "hidden-reply-button-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(hiddenClicks, 0);
  assert.equal(visibleClicks, 1);
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

test("content extraction clicks reply buttons exposed as role=button", async () => {
  let clicks = 0;
  let expanded = false;
  const replyButton = createElement({
    innerText: "Ver 1 resposta",
    getAttribute(name) {
      return name === "aria-label" ? "Ver 1 resposta" : null;
    },
    click() {
      clicks++;
      expanded = true;
    },
  });
  const topNode = createElement({ hidden: false });
  const visibleReply = createElement({ hidden: false });
  const thread = createElement({
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
      if (selector === "[role='button'][aria-label*='respost' i]") {
        return expanded ? [] : [replyButton];
      }
      if (
        selector === "#replies #contents > ytd-comment-view-model, #replies #contents > ytd-comment-renderer, #replies #expanded-threads ytd-comment-view-model, #replies #expanded-threads ytd-comment-renderer" ||
        selector === "#replies ytd-comment-view-model, #replies ytd-comment-renderer"
      ) {
        return expanded ? [visibleReply] : [];
      }
      return [];
    },
  });
  const { listener, progressMessages } = loadContentScript({ commentThreads: [thread] });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "role-button-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(clicks, 1);
  assert.equal(response.result.totalReplies, 1);

  const repliesStage = progressMessages.find((message) => message.stage === "replies");
  assert.equal(repliesStage.threadsExpanded, 1);
  assert.equal(repliesStage.repliesLoaded, 1);
});

test("content extraction finds replies rendered outside the replies container", async () => {
  const topNode = createElement({
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@autor-topo" });
      if (selector === "#content-text") return createElement({ innerText: "Comentario topo" });
      if (selector === "a[href*='lc=']") {
        return createElement({ href: "https://www.youtube.com/watch?v=test&lc=UgxTopDirect" });
      }
      return null;
    },
  });
  const directReply = createElement({
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: "@resposta-direta" });
      if (selector === "#content-text") return createElement({ innerText: "Resposta solta" });
      if (selector === "a[href*='lc=']") {
        return createElement({ href: "https://www.youtube.com/watch?v=test&lc=UgxReplyDirect" });
      }
      return null;
    },
  });
  const thread = createElement({
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
      if (selector === "ytd-comment-view-model") return [topNode, directReply];
      return [];
    },
  });
  const { listener } = loadContentScript({ commentThreads: [thread] });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "containerless-reply-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalThreads, 1);
  assert.equal(response.result.totalReplies, 1);
  assert.equal(response.result.data[0].replies[0].commentId, "UgxReplyDirect");
  assert.equal(response.result.data[0].replies[0].content, "Resposta solta");
  assert.equal(response.result.data[0].replies[0].parentCommentId, "UgxTopDirect");
});

test("content extraction scrolls the reply control into view before clicking", async () => {
  const events = [];
  let label = "Ver 1 resposta";
  const replyButton = createElement({
    isMoreRepliesButton: true,
    getAttribute(name) {
      return name === "aria-label" ? label : null;
    },
    scrollIntoView() {
      events.push("scroll");
    },
    click() {
      events.push("click");
      label = "Ocultar respostas";
    },
  });

  Object.defineProperty(replyButton, "innerText", { get: () => label });

  const { listener } = loadContentScript({
    commentThreads: [createCommentThreadWithButtons([replyButton])],
  });

  await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "scroll-before-click-run" },
  });

  assert.deepEqual(events, ["scroll", "click"]);
});

test("content extraction lists the reply controls when debug paths are on", async () => {
  const replyButton = createElement({
    tagName: "BUTTON",
    id: "more-replies",
    innerText: "Ver 1 resposta",
    getAttribute(name) {
      return name === "aria-label" ? "Ver 1 resposta" : null;
    },
  });
  const thread = createElement({
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "ytd-comment-thread-renderer") return [];
      if (selector === "button") return [replyButton];
      return [];
    },
  });

  const withDebug = loadContentScript({ commentThreads: [thread] });
  const debugResponse = await sendContentMessage(withDebug.listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "debug-controls-run", includeDebugPaths: true },
  });

  const controls = debugResponse.result.data[0].debugReplyControls;

  assert.equal(controls.length, 1);
  assert.equal(controls[0].tag, "button");
  assert.equal(controls[0].id, "more-replies");
  assert.equal(controls[0].label, "ver 1 resposta");

  const withoutDebug = loadContentScript({ commentThreads: [thread] });
  const plainResponse = await sendContentMessage(withoutDebug.listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "plain-controls-run" },
  });

  assert.equal("debugReplyControls" in plainResponse.result.data[0], false);
});

test("content extraction only counts reply expansion when visible replies increase", async () => {
  let expanded = false;
  const topNode = createElement({ hidden: false });
  const hiddenReply = createElement({
    hidden: true,
    getAttribute(name) {
      return name === "hidden" ? "" : null;
    },
  });
  const visibleReply = createElement({ hidden: false });
  const replyButton = createElement({
    innerText: "1 resposta",
    isMoreRepliesButton: true,
    getAttribute(name) {
      return name === "aria-label" ? "1 resposta" : null;
    },
    click() {
      expanded = true;
    },
  });
  const thread = createElement({
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
        selector.includes("#more-replies") ||
        selector.includes("aria-label*='respost'") ||
        selector.includes("aria-label*='reply'")
      ) {
        return expanded ? [] : [replyButton];
      }
      if (
        selector === "#replies #contents > ytd-comment-view-model, #replies #contents > ytd-comment-renderer, #replies #expanded-threads ytd-comment-view-model, #replies #expanded-threads ytd-comment-renderer" ||
        selector === "#replies ytd-comment-view-model, #replies ytd-comment-renderer"
      ) {
        return expanded ? [visibleReply] : [hiddenReply];
      }
      return [];
    },
  });

  const { listener, progressMessages } = loadContentScript({
    commentThreads: [thread],
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "verified-expansion-run" },
  });

  assert.equal(response.ok, true);
  const repliesStage = progressMessages.find((message) => message.stage === "replies");
  assert.equal(repliesStage.buttonsClicked, 1);
  assert.equal(repliesStage.threadsExpanded, 1);
  assert.equal(repliesStage.repliesLoaded, 1);
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
  let expanded = false;
  let replyClicks = 0;
  const topNode = createElement({ hidden: false });
  const hiddenReply = createElement({
    hidden: true,
    getAttribute(name) {
      return name === "hidden" ? "" : null;
    },
  });
  const visibleReply = createElement({ hidden: false });
  const replyButton = createElement({
    innerText: "7 respostas",
    isMoreRepliesButton: true,
    getAttribute(name) {
      return name === "aria-label" ? "7 respostas" : null;
    },
    click() {
      replyClicks++;
      expanded = true;
    },
  });
  const thread = createElement({
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
      if (selector.includes("#more-replies")) return [replyButton];
      if (
        selector === "#replies #contents > ytd-comment-view-model, #replies #contents > ytd-comment-renderer, #replies #expanded-threads ytd-comment-view-model, #replies #expanded-threads ytd-comment-renderer" ||
        selector === "#replies ytd-comment-view-model, #replies ytd-comment-renderer"
      ) {
        return expanded ? [visibleReply] : [hiddenReply];
      }
      return [];
    },
  });

  const { listener } = loadContentScript({
    timers,
    commentThreads: [thread],
  });

  const extraction = sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "skip-replies-run" },
  });

  let reachedRepliesStage = false;
  for (let index = 0; index < 12; index++) {
    await timers.flushNext();
    const status = await sendContentMessage(listener, { type: "YT_COMMENTS_STATUS" });
    if (status.state.stage === "replies") {
      reachedRepliesStage = true;
      break;
    }
  }

  const skipResponse = await sendContentMessage(listener, {
    type: "YT_COMMENTS_SKIP_STEP",
  });
  await timers.flushAll();
  const response = await extraction;

  assert.equal(reachedRepliesStage, true);
  assert.equal(skipResponse.ok, true);
  assert.equal(skipResponse.skippedStage, "replies");
  assert.equal(response.ok, true);
  assert.ok(replyClicks >= 1);
});

function createCommentTopNode({ author = "@canal", content = "Comentario", commentId = "UgwTop" }) {
  return createElement({
    querySelector(selector) {
      if (selector === "#author-text") return createElement({ innerText: author });
      if (selector === "#content-text") return createElement({ innerText: content });
      if (selector === "#vote-count-middle") return createElement({ innerText: "4" });
      if (selector === "a[href*='lc=']") {
        return createElement({
          innerText: "ha 1 dia",
          href: `https://www.youtube.com/watch?v=test&lc=${commentId}`,
        });
      }
      return null;
    },
  });
}

test("content extraction opens the comments panel and scrolls its own scroller", async () => {
  const scrollEvents = [];
  let quickActionClicks = 0;
  const thread = createStructuredThread({ topNode: createCommentTopNode({ commentId: "UgwPanel" }) });
  const panel = createElement({
    clientHeight: 400,
    scrollHeight: 4000,
    scrollTop: 0,
    closest(selector) {
      const panelSelector =
        "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-comments-section']";
      return selector === panelSelector ? this : null;
    },
    getAttribute(name) {
      return name === "visibility" ? "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN" : null;
    },
    querySelector(selector) {
      return selector === "ytd-comment-thread-renderer" ? thread : null;
    },
    scrollIntoView() {
      scrollEvents.push("comments-panel");
    },
  });
  const quickActionButton = createElement({
    getAttribute(name) {
      return name === "aria-label" ? "Comentários" : null;
    },
    click() {
      quickActionClicks++;
    },
  });
  const { listener } = loadContentScript({
    commentThreads: [thread],
    commentsPanel: panel,
    quickActionButtons: [quickActionButton],
    scrollEvents,
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 2, runId: "comments-panel-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(quickActionClicks, 1);
  assert.equal(panel.scrollTop, 4000);
  assert.deepEqual(scrollEvents, ["comments-panel"]);
  assert.equal(response.result.totalThreads, 1);
});

test("content extraction scrolls a scroller nested inside the comments panel", async () => {
  const scrollEvents = [];
  const thread = createStructuredThread({
    topNode: createCommentTopNode({ commentId: "UgxInnerScroller" }),
  });
  const innerScroller = createElement({ clientHeight: 300, scrollHeight: 3000, scrollTop: 0 });
  const panel = createElement({
    clientHeight: 0,
    scrollHeight: 0,
    closest(selector) {
      const panelSelector =
        "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-comments-section']";
      return selector === panelSelector ? this : null;
    },
    getAttribute(name) {
      return name === "visibility" ? "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" : null;
    },
    querySelector(selector) {
      return selector === "ytd-comment-thread-renderer" ? thread : null;
    },
    querySelectorAll(selector) {
      return selector === "*" ? [innerScroller] : [];
    },
    scrollIntoView() {
      scrollEvents.push("comments-panel");
    },
  });
  const { listener } = loadContentScript({
    commentThreads: [thread],
    commentsPanel: panel,
    scrollEvents,
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 2, runId: "inner-scroller-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalThreads, 1);
  assert.equal(innerScroller.scrollTop, 3000);
  assert.deepEqual(scrollEvents, ["comments-panel"]);
});

test("content extraction retries through the comments panel when nothing was loaded", async () => {
  const thread = createStructuredThread({
    topNode: createCommentTopNode({ commentId: "UgxPanelRetry" }),
  });
  const inlineRoot = createElement({
    clientHeight: 600,
    scrollIntoView() {},
  });
  const panelScroller = createElement({ clientHeight: 300, scrollHeight: 3000 });
  const panel = createElement({
    clientHeight: 700,
    closest(selector) {
      const panelSelector =
        "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-comments-section']";
      return selector === panelSelector ? this : null;
    },
    getAttribute(name) {
      return name === "visibility" ? "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" : null;
    },
    querySelector(selector) {
      return selector === "ytd-comment-thread-renderer" ? thread : null;
    },
    querySelectorAll(selector) {
      return selector === "*" ? [panelScroller] : [];
    },
  });
  let loaded = false;

  Object.defineProperty(panelScroller, "scrollTop", {
    get: () => 0,
    set: () => {
      loaded = true;
    },
  });

  const { listener } = loadContentScript({
    commentThreads: () => (loaded ? [thread] : []),
    commentsRoot: inlineRoot,
    commentsPanel: panel,
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 1, runId: "panel-retry-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalThreads, 1);
});

test("content extraction keeps a single entry when the same thread is rendered twice", async () => {
  const threadA = createStructuredThread({
    topNode: createCommentTopNode({ commentId: "UgwDuplicated" }),
  });
  const threadB = createStructuredThread({
    topNode: createCommentTopNode({ commentId: "UgwDuplicated" }),
  });
  const { listener } = loadContentScript({ commentThreads: [threadA, threadB] });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "duplicate-thread-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalThreads, 1);
  assert.equal(response.result.data[0].commentId, "UgwDuplicated");
});

test("content extraction keeps scrolling while the loaded comments are below the reported total", async () => {
  const commentsHeader = createElement({
    querySelector(selector) {
      if (selector === "#count") return createElement({ innerText: "13" });
      return null;
    },
  });
  const scrollsWithTotal = [];
  const scrollsWithoutTotal = [];

  const withExpectedCount = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
    commentsHeader,
    scrollEvents: scrollsWithTotal,
  });
  await sendContentMessage(withExpectedCount.listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 10, runId: "below-total-run" },
  });

  const withoutExpectedCount = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
    scrollEvents: scrollsWithoutTotal,
  });
  await sendContentMessage(withoutExpectedCount.listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 10, runId: "no-total-run" },
  });

  const countScrolls = (events) => events.filter((event) => event === "end-scroll").length;

  assert.equal(countScrolls(scrollsWithTotal), 9);
  assert.equal(countScrolls(scrollsWithoutTotal), 6);
});

test("content extraction reports the comment count shown by YouTube", async () => {
  const commentsHeader = createElement({
    querySelector(selector) {
      if (selector === "#count") return createElement({ innerText: "1,2 mil" });
      return null;
    },
  });
  const { listener, progressMessages } = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
    commentsHeader,
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "expected-count-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.expectedCommentCount, 1200);
  assert.equal(progressMessages.at(-1).expectedCommentCount, 1200);
});

test("content extraction stores the canonical video url and id", async () => {
  const { listener, sandbox } = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
  });
  sandbox.location.href = "https://www.youtube.com/watch?v=abc123&list=PL123&t=42s";

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "canonical-url-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.videoId, "abc123");
  assert.equal(response.result.url, "https://www.youtube.com/watch?v=abc123");
});

function createApiPage(items) {
  return {
    onResponseReceivedEndpoints: [
      { appendContinuationItemsAction: { continuationItems: items } },
    ],
  };
}

function createApiContinuationItem(token) {
  return {
    continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } },
  };
}

function createApiThreadItem({ commentId, content, author = "@canal", replies = [] }) {
  return {
    commentThreadRenderer: {
      comment: {
        commentRenderer: {
          commentId,
          authorText: { simpleText: author },
          contentText: { simpleText: content },
          replies: { commentRepliesRenderer: { contents: replies } },
        },
      },
    },
  };
}

function createApiReplyItem(commentId, content) {
  return { commentRenderer: { commentId, contentText: { simpleText: content } } };
}

function createFetchStub(pages, requests = []) {
  return async (_url, options) => {
    requests.push(JSON.parse(options.body).continuation);
    const payload = pages[requests.length - 1];

    return { ok: Boolean(payload), status: payload ? 200 : 403, json: async () => payload || {} };
  };
}

test("content extraction can load comments through the internal API", async () => {
  const requests = [];
  const fetchImpl = createFetchStub(
    [
      createApiPage([
        createApiThreadItem({ commentId: "UgxApi1", content: "Primeiro" }),
        createApiContinuationItem("PAGE_2"),
      ]),
      createApiPage([createApiThreadItem({ commentId: "UgxApi2", content: "Segundo" })]),
    ],
    requests
  );
  const { listener } = loadContentScript({ commentThreads: [], fetchImpl });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: { client: { clientName: "WEB" } }, continuationToken: "PAGE_1" },
      runId: "api-run",
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(requests, ["PAGE_1", "PAGE_2"]);
  assert.equal(response.result.mode, "api");
  assert.equal(response.result.totalThreads, 2);
  assert.deepEqual(
    Array.from(response.result.data, (comment) => comment.commentId),
    ["UgxApi1", "UgxApi2"]
  );
});

test("content extraction loads thread replies through the API continuation", async () => {
  const requests = [];
  const fetchImpl = createFetchStub(
    [
      createApiPage([
        createApiThreadItem({
          commentId: "UgxApiTop",
          content: "Comentario com respostas",
          replies: [
            createApiReplyItem("UgxApiReply1", "Resposta um"),
            createApiContinuationItem("REPLY_PAGE"),
          ],
        }),
      ]),
      createApiPage([createApiReplyItem("UgxApiReply2", "Resposta dois")]),
    ],
    requests
  );
  const { listener } = loadContentScript({ commentThreads: [], fetchImpl });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1" },
      runId: "api-replies-run",
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(requests, ["PAGE_1", "REPLY_PAGE"]);
  assert.equal(response.result.totalThreads, 1);
  assert.equal(response.result.totalReplies, 2);
  assert.deepEqual(
    Array.from(response.result.data[0].replies, (reply) => reply.commentId),
    ["UgxApiReply1", "UgxApiReply2"]
  );
  assert.equal(response.result.data[0].replies[0].parentCommentId, "UgxApiTop");
  assert.equal(response.result.data[0].repliesContinuationToken, undefined);
});

test("content extraction reads decorated replies from the API entity batch", async () => {
  const requests = [];
  const decoratedReplyPage = {
    onResponseReceivedEndpoints: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            {
              commentThreadRenderer: {
                commentViewModel: {
                  commentViewModel: {
                    commentKey: "REPLY_ENTITY_KEY",
                    commentId: "UgxDecoratedReply",
                  },
                },
              },
            },
          ],
          targetId: "comment-replies-item-UgxApiTop",
        },
      },
    ],
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [
          {
            entityKey: "REPLY_ENTITY_KEY",
            payload: {
              commentEntityPayload: {
                key: "REPLY_ENTITY_KEY",
                properties: {
                  commentId: "UgxDecoratedReply",
                  content: { content: "Resposta decorada" },
                  publishedTime: "ha 1 dia",
                  replyLevel: 1,
                },
                author: { displayName: "@decorado" },
                toolbar: { likeCountLiked: " ", likeCountNotliked: "2" },
              },
            },
          },
        ],
      },
    },
  };
  const fetchImpl = createFetchStub(
    [
      createApiPage([
        createApiThreadItem({
          commentId: "UgxApiTop",
          content: "Comentario com resposta decorada",
          replies: [createApiContinuationItem("REPLY_PAGE")],
        }),
      ]),
      decoratedReplyPage,
    ],
    requests
  );
  const { listener } = loadContentScript({ commentThreads: [], fetchImpl });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1" },
      runId: "decorated-replies-run",
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(requests, ["PAGE_1", "REPLY_PAGE"]);
  assert.equal(response.result.totalReplies, 1);

  const reply = response.result.data[0].replies[0];
  assert.equal(reply.commentId, "UgxDecoratedReply");
  assert.equal(reply.author, "@decorado");
  assert.equal(reply.content, "Resposta decorada");
  assert.equal(reply.likes, "2");
  assert.equal(reply.parentCommentId, "UgxApiTop");
  assert.equal("replies" in reply, false);
  assert.equal("repliesContinuationToken" in reply, false);
});

test("content extraction builds the replies token when the API does not provide one", async () => {
  const requests = [];
  const fetchImpl = createFetchStub(
    [
      createApiPage([createApiThreadItem({ commentId: "UgxNoToken", content: "Sem token" })]),
      createApiPage([createApiReplyItem("UgxBuiltReply", "Resposta via token construido")]),
    ],
    requests
  );
  const { listener } = loadContentScript({ commentThreads: [], fetchImpl });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1", videoChannelId: "UCowner" },
      runId: "built-token-run",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalReplies, 1);
  assert.equal(response.result.data[0].replies[0].content, "Resposta via token construido");
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1],
    core.buildRepliesContinuationToken({
      videoId: "test",
      commentId: "UgxNoToken",
      channelId: "UCowner",
    })
  );
});

function createDecoratedPage({ key, commentId, content, author = "@canal", replyCountA11y = "" }) {
  return {
    onResponseReceivedEndpoints: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            { commentThreadRenderer: { commentViewModel: { commentViewModel: { commentKey: key } } } },
          ],
        },
      },
    ],
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [
          {
            entityKey: key,
            payload: {
              commentEntityPayload: {
                key,
                properties: { commentId, content: { content } },
                author: { displayName: author },
                toolbar: { replyCount: "", replyCountA11y },
              },
            },
          },
        ],
      },
    },
  };
}

test("content extraction skips reply requests for threads without replies", async () => {
  const requests = [];
  const fetchImpl = createFetchStub(
    [createDecoratedPage({ key: "NO_REPLY_KEY", commentId: "UgxNoReplies", content: "Sem respostas", replyCountA11y: "0 resposta" })],
    requests
  );
  const { listener } = loadContentScript({ commentThreads: [], fetchImpl });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1", videoChannelId: "UCowner" },
      runId: "no-replies-run",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalThreads, 1);
  assert.equal(response.result.totalReplies, 0);
  assert.deepEqual(requests, ["PAGE_1"]);
});

test("content extraction flags a truncated result when the reply limit is reached", async () => {
  const requests = [];
  const fetchImpl = createFetchStub(
    [
      createApiPage([
        createApiThreadItem({
          commentId: "UgxFirst",
          content: "Primeiro",
          replies: [createApiContinuationItem("REPLY_FIRST")],
        }),
        createApiThreadItem({
          commentId: "UgxSecond",
          content: "Segundo",
          replies: [createApiContinuationItem("REPLY_SECOND")],
        }),
      ]),
      createApiPage([createApiReplyItem("UgxFirstReply", "Resposta do primeiro")]),
    ],
    requests
  );
  const { listener } = loadContentScript({ commentThreads: [], fetchImpl });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1" },
      maxReplyThreads: 1,
      runId: "truncated-run",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.truncated, true);
  assert.deepEqual(requests, ["PAGE_1", "REPLY_FIRST"]);
});

test("content extraction flags a truncated thread when its replies keep going", async () => {
  const requests = [];
  const replyPages = [];

  for (let page = 0; page < 12; page++) {
    replyPages.push(
      createApiPage([
        createApiReplyItem(`UgxDeepReply${page}`, `Resposta profunda ${page}`),
        createApiContinuationItem(`DEEP_${page + 1}`),
      ])
    );
  }

  const fetchImpl = createFetchStub(
    [
      createApiPage([
        createApiThreadItem({
          commentId: "UgxDeepThread",
          content: "Thread com muitas respostas",
          replies: [createApiContinuationItem("DEEP_1")],
        }),
      ]),
      ...replyPages,
    ],
    requests
  );
  const { listener } = loadContentScript({ commentThreads: [], fetchImpl });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1" },
      runId: "deep-thread-run",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.truncated, true);
  assert.equal(response.result.totalReplies, 10);
  assert.equal(requests.length, 11);
});

test("content extraction falls back to the page channel meta for the replies token", async () => {
  const requests = [];
  const fetchImpl = createFetchStub(
    [
      createApiPage([createApiThreadItem({ commentId: "UgxMetaChannel", content: "Sem canal no bridge" })]),
      createApiPage([createApiReplyItem("UgxMetaReply", "Resposta via canal do meta")]),
    ],
    requests
  );
  const { listener } = loadContentScript({
    commentThreads: [],
    fetchImpl,
    pageChannelId: "UCfromMetaTag",
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1" },
      runId: "page-channel-run",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.totalReplies, 1);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1],
    core.buildRepliesContinuationToken({
      videoId: "test",
      commentId: "UgxMetaChannel",
      channelId: "UCfromMetaTag",
    })
  );
});

test("content extraction reports the API diagnostics when debug paths are on", async () => {
  const fetchImpl = createFetchStub([
    createApiPage([createApiThreadItem({ commentId: "UgxDebugApi", content: "Com debug" })]),
    createApiPage([createApiReplyItem("UgxDebugReply", "Resposta do debug")]),
  ]);
  const { listener } = loadContentScript({
    commentThreads: [],
    fetchImpl,
    pageChannelId: "UCdebugMeta",
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1" },
      runId: "api-debug-run",
      includeDebugPaths: true,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.debugApi.videoChannelId, "UCdebugMeta");
  assert.equal(response.result.debugApi.attemptedThreads, 1);
  assert.equal(response.result.debugApi.builtTokens, 1);
  assert.equal(response.result.debugApi.withoutToken, 0);
  assert.equal(response.result.debugApi.failedThreads, 0);
});

test("content extraction falls back to the DOM when the comments token is a replies token", async () => {
  const repliesTargetPage = {
    onResponseReceivedEndpoints: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            createApiThreadItem({ commentId: "UgxWrongPage", content: "Pagina errada" }),
          ],
          targetId: "comment-replies-item-UgxApiTop",
        },
      },
    ],
  };
  const { listener, progressMessages } = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
    fetchImpl: createFetchStub([repliesTargetPage]),
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1" },
      maxScrollRounds: 0,
      runId: "replies-token-run",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.mode, "crawler");
  assert.equal(response.result.totalThreads, 1);
  assert.ok(
    progressMessages.some((message) => message.source === "api" && message.fallback === true)
  );
});

test("content extraction falls back to the DOM when the internal API refuses", async () => {
  const { listener, progressMessages } = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
    fetchImpl: createFetchStub([]),
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1" },
      maxScrollRounds: 0,
      runId: "api-fallback-run",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.mode, "crawler");
  assert.equal(response.result.totalThreads, 1);
  assert.ok(
    progressMessages.some((message) => message.source === "api" && message.fallback === true)
  );
});

test("content extraction falls back to the DOM when the page context is unavailable", async () => {
  const { listener } = loadContentScript({ commentThreads: [createLoadedCommentThread()] });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { mode: "api", api: null, maxScrollRounds: 0, runId: "api-no-context-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.mode, "crawler");
});
