(() => {
  if (globalThis.__YT_COMMENTS_EXTRACTOR_LOADED__) return;
  globalThis.__YT_COMMENTS_EXTRACTOR_LOADED__ = true;

  const core = globalThis.YouTubeCommentsExtractorCore;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (el) => core.normalizeText(el?.innerText || el?.textContent || "");
  const qsa = (root, selector) => Array.from(root.querySelectorAll(selector));
  const extractionState = {
    phase: "idle",
    runId: null,
    stage: null,
    commentsSeen: 0,
    visibleCommentCount: 0,
    skipRequestedStage: null,
    result: null,
    error: null,
  };

  function getStateSnapshot() {
    return {
      phase: extractionState.phase,
      runId: extractionState.runId,
      stage: extractionState.stage,
      commentsSeen: extractionState.commentsSeen,
      visibleCommentCount: extractionState.visibleCommentCount,
      skipRequestedStage: extractionState.skipRequestedStage,
      result: extractionState.result,
      error: extractionState.error,
    };
  }

  function reportProgress(stage, details = {}) {
    extractionState.phase = "running";
    extractionState.stage = stage;
    extractionState.runId = details.runId || extractionState.runId;
    extractionState.error = null;

    if (typeof details.commentsSeen === "number") {
      extractionState.commentsSeen = details.commentsSeen;
    }

    if (typeof details.visibleCommentCount === "number") {
      extractionState.visibleCommentCount = details.visibleCommentCount;
    }

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

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
    return String(value).replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1");
  }

  function domPath(node, stopAt = document.body) {
    if (!node || node.nodeType === 3) {
      node = node?.parentElement || null;
    }

    if (!node || node.nodeType && node.nodeType !== 1) return null;

    const parts = [];
    let current = node;

    while (current && current !== stopAt && current.nodeType !== 9) {
      let selector = current.tagName?.toLowerCase?.() || null;
      if (!selector) break;

      if (current.id) {
        selector += `#${cssEscape(current.id)}`;
        parts.unshift(selector);
        break;
      }

      const parent = current.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children || []).filter(
          (child) => child.tagName === current.tagName
        );

        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      parts.unshift(selector);
      current = current.parentElement;
    }

    return parts.join(" > ") || null;
  }

  function getLcCommentIdFromHref(href) {
    return href?.match(/[?&]lc=([^&]+)/)?.[1] || null;
  }

  function getNodeAttribute(node, attribute) {
    const value = node?.getAttribute?.(attribute);
    return value ? String(value) : null;
  }

  function isGenericCommentDomId(value) {
    return value === "comment" || value === "comments";
  }

  function getCommentIdFromNode(node) {
    const hrefCommentId =
      getLcCommentIdFromHref(node?.querySelector("a[href*='lc=']")?.href) ||
      getLcCommentIdFromHref(node?.querySelector("#published-time-text a[href*='lc=']")?.href);

    const dataCommentId =
      getNodeAttribute(node, "data-id") ||
      getNodeAttribute(node, "data-comment-id") ||
      getNodeAttribute(node, "comment-id");

    const domId = node?.id && !isGenericCommentDomId(node.id) ? node.id : null;
    const nestedCommentDomId =
      node?.querySelector('[id^="comment"]')?.id &&
      !isGenericCommentDomId(node.querySelector('[id^="comment"]')?.id)
        ? node.querySelector('[id^="comment"]')?.id
        : null;

    return (
      hrefCommentId ||
      dataCommentId ||
      domId ||
      nestedCommentDomId ||
      null
    );
  }

  function getThreadCommentId(thread, topNode) {
    return (
      getCommentIdFromNode(topNode) ||
      getNodeAttribute(thread, "data-id") ||
      (thread.id && !isGenericCommentDomId(thread.id) ? thread.id : null) ||
      getLcCommentIdFromHref(thread.querySelector("a[href*='lc=']")?.href) ||
      null
    );
  }

  function parseCommentNode(node, fallbackCommentId = null, includeDebugPaths = false) {
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
    const record = {
      commentId: getCommentIdFromNode(node) || fallbackCommentId,
      author,
      authorChannelUrl,
      content,
      published,
      likes,
    };

    if (includeDebugPaths) {
      const authorNode = node.querySelector("#author-text") || node.querySelector("#header-author a");
      const textNode =
        node.querySelector("#content-text") ||
        node.querySelector("yt-attributed-string") ||
        node.querySelector("#comment-content");

      record.debugPaths = {
        thread: domPath(node),
        text: domPath(textNode),
        author: domPath(authorNode),
      };
    }

    return record;
  }

  function isReplyExpansionButton(button) {
    const label = `${text(button)} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
    const isReactionOrComposer =
      label.includes("like") ||
      label.includes("dislike") ||
      label.includes("gostei") ||
      label.includes("nao gostei") ||
      label.includes("não gostei") ||
      label.includes("responder") ||
      label.includes("add a reply") ||
      label.includes("write a reply");

    if (isReactionOrComposer) return false;

    return (
      /\b(view|show)\b.*\brepl/.test(label) ||
      /\b(ver|mostrar)\b.*\brespost/.test(label) ||
      /\b\d+\s+repl/.test(label) ||
      /\b\d+\s+respost/.test(label) ||
      label.includes("view reply") ||
      label.includes("view replies") ||
      label.includes("show reply") ||
      label.includes("show replies") ||
      label.includes("more repl") ||
      label.includes("ver resposta") ||
      label.includes("ver respostas") ||
      label.includes("mostrar resposta") ||
      label.includes("mostrar respostas") ||
      label.includes("mais resposta") ||
      label.includes("mais respostas")
    );
  }

  async function clickAllReplyButtons(thread) {
    const selectors = [
      "button[aria-label*='respost' i]",
      "button[aria-label*='reply' i]",
      "tp-yt-paper-button[aria-label*='respost' i]",
      "tp-yt-paper-button[aria-label*='reply' i]",
      "#more-replies button",
      "#more-replies tp-yt-paper-button",
      "#more-replies-sub-thread button",
      "#more-replies-sub-thread tp-yt-paper-button",
      "ytd-button-renderer#more-replies button",
      "ytd-button-renderer#more-replies-sub-thread button",
    ];

    let clicked = 0;
    const seen = new Set();

    for (const selector of selectors) {
      for (const button of qsa(thread, selector)) {
        if (seen.has(button)) continue;
        seen.add(button);

        if (!isReplyExpansionButton(button)) continue;

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

  function getCommentThreads() {
    return qsa(document, "ytd-comment-thread-renderer");
  }

  function isVisibleNode(node) {
    if (!node) return false;
    if (node.hidden) return false;
    if (node.getAttribute?.("hidden") !== null) return false;
    return true;
  }

  function countVisibleComments(threads = getCommentThreads()) {
    return threads.reduce((sum, thread) => {
      const topNode =
        thread.querySelector("#comment ytd-comment-view-model") ||
        thread.querySelector("#comment ytd-comment-renderer") ||
        thread.querySelector("ytd-comment-view-model") ||
        thread.querySelector("ytd-comment-renderer");

      const replyNodes = qsa(
        thread,
        "#replies #contents > ytd-comment-view-model, #replies #contents > ytd-comment-renderer, #replies #expanded-threads ytd-comment-view-model, #replies #expanded-threads ytd-comment-renderer"
      ).filter((replyNode) => replyNode !== topNode && isVisibleNode(replyNode));

      return sum + (isVisibleNode(topNode) ? 1 : 0) + replyNodes.length;
    }, 0);
  }

  async function moveToCommentsSection() {
    const commentsRoot = document.querySelector("ytd-comments#comments, ytd-comments, #comments");

    try {
      commentsRoot?.scrollIntoView({ block: "start", behavior: "instant" });
    } catch {
      commentsRoot?.scrollIntoView();
    }

    await wait(900);
  }

  async function scrollToPageEnd() {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await wait(1400);
  }

  async function autoScrollComments(maxRounds = 30, runId = null) {
    await moveToCommentsSection();

    for (let index = 0; index < 3; index++) {
      await scrollToPageEnd();
    }

    let lastCount = 0;
    let stableRounds = 0;
    let mappedThreads = getCommentThreads();
    reportProgress("scroll", {
      runId,
      round: 0,
      maxRounds,
      commentsSeen: mappedThreads.length,
      visibleCommentCount: countVisibleComments(mappedThreads),
    });

    for (let index = 0; index < maxRounds; index++) {
      await scrollToPageEnd();

      mappedThreads = getCommentThreads();
      const count = mappedThreads.length;
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
        visibleCommentCount: countVisibleComments(mappedThreads),
      });

      if (stableRounds >= 2) break;
    }

    return mappedThreads;
  }

  async function expandAllReplies(threads, maxPasses = 4, runId = null) {
    for (let pass = 0; pass < maxPasses; pass++) {
      if (extractionState.skipRequestedStage === "replies") {
        extractionState.skipRequestedStage = null;
        break;
      }

      let clickedInPass = 0;
      for (const thread of threads) {
        clickedInPass += await clickAllReplyButtons(thread);
      }

      reportProgress("replies", {
        runId,
        pass: pass + 1,
        maxPasses,
        buttonsClicked: clickedInPass,
        visibleCommentCount: countVisibleComments(threads),
      });

      if (clickedInPass === 0) break;
      await wait(900);
    }
  }

  function collect(threads = getCommentThreads(), includeDebugPaths = false) {
    const data = threads.map((thread, index) => {
      const topNode =
        thread.querySelector("#comment ytd-comment-view-model") ||
        thread.querySelector("#comment ytd-comment-renderer") ||
        thread.querySelector("ytd-comment-view-model") ||
        thread.querySelector("ytd-comment-renderer");

      const topComment = topNode
        ? parseCommentNode(topNode, getThreadCommentId(thread, topNode), includeDebugPaths)
        : { commentId: getThreadCommentId(thread, null) };

      const replyNodes = qsa(
        thread,
        "#replies ytd-comment-view-model, #replies ytd-comment-renderer"
      ).filter((replyNode) => replyNode !== topNode);

      const replies = replyNodes.map((replyNode) =>
        parseCommentNode(replyNode, null, includeDebugPaths)
      );

      return core.buildCommentRecord(topComment, replies, index);
    });

    return {
      ...getVideoMeta(),
      collectedAt: new Date().toISOString(),
      totalThreads: data.length,
      totalReplies: data.reduce((sum, comment) => sum + comment.repliesCount, 0),
      visibleCommentCount: countVisibleComments(threads),
      data,
    };
  }

  async function runExtraction(options = {}) {
    const maxScrollRounds = Number(options.maxScrollRounds ?? 30);
    const runId = options.runId || null;
    const includeDebugPaths = Boolean(options.includeDebugPaths);

    if (extractionState.phase === "running") {
      throw new Error("Uma extracao ja esta em andamento nesta aba.");
    }

    extractionState.phase = "running";
    extractionState.runId = runId;
    extractionState.stage = "scroll";
    extractionState.commentsSeen = 0;
    extractionState.visibleCommentCount = 0;
    extractionState.skipRequestedStage = null;
    extractionState.result = null;
    extractionState.error = null;

    const mappedThreads = await autoScrollComments(maxScrollRounds, runId);
    await expandAllReplies(mappedThreads, 4, runId);
    reportProgress("collect", {
      runId,
      visibleCommentCount: countVisibleComments(mappedThreads),
    });
    await wait(1200);

    const result = collect(mappedThreads, includeDebugPaths);
    if (result.totalThreads === 0) {
      throw new Error(
        "Nenhum comentario foi encontrado. Aguarde o YouTube carregar os comentarios ou tente aumentar as rodadas de scroll."
      );
    }

    window.__YT_COMMENTS__ = result;
    extractionState.phase = "complete";
    extractionState.stage = "complete";
    extractionState.skipRequestedStage = null;
    extractionState.result = result;
    extractionState.error = null;
    console.log("[YT Comments Extractor] Resultado salvo em window.__YT_COMMENTS__", result);

    return result;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "YT_COMMENTS_STATUS") {
      sendResponse({ ok: true, state: getStateSnapshot() });
      return false;
    }

    if (message?.type === "YT_COMMENTS_SKIP_STEP") {
      if (extractionState.phase !== "running" || extractionState.stage !== "replies") {
        sendResponse({
          ok: false,
          error: "Nenhuma etapa pulavel esta ativa no momento.",
        });
        return false;
      }

      extractionState.skipRequestedStage = "replies";
      sendResponse({ ok: true, skippedStage: "replies" });
      return false;
    }

    if (message?.type !== "YT_COMMENTS_EXTRACT") return false;

    runExtraction(message.options)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        extractionState.phase = "error";
        extractionState.stage = extractionState.stage || "scroll";
        extractionState.skipRequestedStage = null;
        extractionState.error = error?.message || String(error);
        sendResponse({
          ok: false,
          error: error?.message || String(error),
        });
      });

    return true;
  });
})();
