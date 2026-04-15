(() => {
  if (globalThis.__YT_COMMENTS_EXTRACTOR_LOADED__) return;
  globalThis.__YT_COMMENTS_EXTRACTOR_LOADED__ = true;

  const core = globalThis.YouTubeCommentsExtractorCore;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (el) => core.normalizeText(el?.innerText || el?.textContent || "");
  const qsa = (root, selector) => Array.from(root.querySelectorAll(selector));

  function reportProgress(stage, details = {}) {
    try {
      chrome.runtime.sendMessage({
        type: "YT_COMMENTS_PROGRESS",
        stage,
        ...details,
      });
    } catch {
      // The popup may have been closed while extraction continues.
    }
  }

  function getVideoMeta() {
    return {
      url: location.href,
      title: text(document.querySelector("ytd-watch-metadata h1")) || document.title,
    };
  }

  function getCommentIdFromNode(node) {
    return (
      node?.getAttribute("data-id") ||
      node?.id ||
      node?.querySelector("a[href*='lc=']")?.href?.match(/[?&]lc=([^&]+)/)?.[1] ||
      node?.querySelector('[id^="comment"]')?.id ||
      null
    );
  }

  function getThreadCommentId(thread, topNode) {
    return (
      getCommentIdFromNode(topNode) ||
      thread.getAttribute("data-id") ||
      thread.id ||
      thread.querySelector("a[href*='lc=']")?.href?.match(/[?&]lc=([^&]+)/)?.[1] ||
      null
    );
  }

  function parseCommentNode(node, fallbackCommentId = null) {
    const author =
      text(node.querySelector("#author-text")) ||
      text(node.querySelector("#header-author a")) ||
      text(node.querySelector("a.yt-simple-endpoint.style-scope.yt-formatted-string"));

    const content =
      text(node.querySelector("#content-text")) ||
      text(node.querySelector("yt-attributed-string")) ||
      text(node.querySelector("#comment-content"));

    const published =
      text(node.querySelector("a[href*='lc=']")) ||
      text(node.querySelector(".published-time-text a")) ||
      text(node.querySelector("#published-time-text a"));

    const likes =
      text(node.querySelector("#vote-count-middle")) ||
      text(node.querySelector("#vote-count")) ||
      "0";

    const authorChannelUrl =
      node.querySelector("#author-text")?.href ||
      node.querySelector("#header-author a")?.href ||
      null;

    return {
      commentId: getCommentIdFromNode(node) || fallbackCommentId,
      author,
      authorChannelUrl,
      content,
      published,
      likes,
    };
  }

  async function clickAllReplyButtons(thread) {
    const selectors = [
      "button[aria-label*='respost' i]",
      "button[aria-label*='reply' i]",
      "tp-yt-paper-button[aria-label*='respost' i]",
      "tp-yt-paper-button[aria-label*='reply' i]",
      "#more-replies button",
      "#more-replies tp-yt-paper-button",
      "ytd-button-renderer#more-replies button",
    ];

    let clicked = 0;
    const seen = new Set();

    for (const selector of selectors) {
      for (const button of qsa(thread, selector)) {
        if (seen.has(button)) continue;
        seen.add(button);

        const label = `${text(button)} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
        const opensReplies =
          label.includes("respost") ||
          label.includes("reply") ||
          label.includes("more repl") ||
          label.includes("ver resposta") ||
          label.includes("view repl");

        if (!opensReplies) continue;

        try {
          button.click();
          clicked++;
          await wait(650);
        } catch {
          // Ignore stale YouTube nodes while the page rerenders.
        }
      }
    }

    return clicked;
  }

  async function autoScrollComments(maxRounds = 30, runId = null) {
    let lastCount = 0;
    let stableRounds = 0;

    for (let index = 0; index < maxRounds; index++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await wait(1400);

      const count = document.querySelectorAll("ytd-comment-thread-renderer").length;
      if (count === lastCount) {
        stableRounds++;
      } else {
        stableRounds = 0;
        lastCount = count;
      }

      reportProgress("scroll", {
        runId,
        round: index + 1,
        maxRounds,
        commentsSeen: count,
      });

      if (stableRounds >= 2) break;
    }
  }

  async function expandAllReplies(maxPasses = 4, runId = null) {
    for (let pass = 0; pass < maxPasses; pass++) {
      let clickedInPass = 0;
      for (const thread of qsa(document, "ytd-comment-thread-renderer")) {
        clickedInPass += await clickAllReplyButtons(thread);
      }

      reportProgress("replies", {
        runId,
        pass: pass + 1,
        maxPasses,
        buttonsClicked: clickedInPass,
      });

      if (clickedInPass === 0) break;
      await wait(900);
    }
  }

  function collect() {
    const threads = qsa(document, "ytd-comment-thread-renderer");

    const data = threads.map((thread, index) => {
      const topNode =
        thread.querySelector("#comment ytd-comment-view-model") ||
        thread.querySelector("#comment ytd-comment-renderer") ||
        thread.querySelector("ytd-comment-view-model") ||
        thread.querySelector("ytd-comment-renderer");

      const topComment = topNode
        ? parseCommentNode(topNode, getThreadCommentId(thread, topNode))
        : { commentId: getThreadCommentId(thread, null) };

      const replyNodes = qsa(
        thread,
        "#replies ytd-comment-view-model, #replies ytd-comment-renderer"
      ).filter((replyNode) => replyNode !== topNode);

      const replies = replyNodes.map((replyNode) => parseCommentNode(replyNode));

      return core.buildCommentRecord(topComment, replies, index);
    });

    return {
      ...getVideoMeta(),
      collectedAt: new Date().toISOString(),
      totalThreads: data.length,
      totalReplies: data.reduce((sum, comment) => sum + comment.repliesCount, 0),
      data,
    };
  }

  async function runExtraction(options = {}) {
    const maxScrollRounds = Number(options.maxScrollRounds || 30);
    const runId = options.runId || null;

    await autoScrollComments(maxScrollRounds, runId);
    await expandAllReplies(4, runId);
    reportProgress("collect", { runId });
    await wait(1200);

    const result = collect();
    window.__YT_COMMENTS__ = result;
    console.log("[YT Comments Extractor] Resultado salvo em window.__YT_COMMENTS__", result);

    return result;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "YT_COMMENTS_EXTRACT") return false;

    runExtraction(message.options)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || String(error),
        });
      });

    return true;
  });
})();
