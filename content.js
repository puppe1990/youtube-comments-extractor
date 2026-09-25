(() => {
  if (globalThis.__YT_COMMENTS_EXTRACTOR_LOADED__) return;
  globalThis.__YT_COMMENTS_EXTRACTOR_LOADED__ = true;

  const core = globalThis.YouTubeCommentsExtractorCore;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (el) => core.normalizeText(el?.innerText || el?.textContent || "");
  const qsa = (root, selector) => Array.from(root.querySelectorAll(selector));
  const normalizeLabel = (value) =>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  const queryFirst = (root, selectors) => {
    for (const selector of selectors) {
      const node = root?.querySelector?.(selector);
      if (node) return node;
    }

    return null;
  };
  const uniqueNodes = (nodes) => {
    const seen = new Set();

    return nodes.filter((node) => {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      return true;
    });
  };

  const COMMENTS_PANEL_SELECTOR =
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-comments-section']";
  const INLINE_COMMENTS_SELECTOR = "ytd-comments#comments, ytd-comments, ytm-comments, #comments";
  const COMMENTS_COUNT_SELECTOR = "ytd-comments-header-renderer";
  const PANEL_EXPANDED_VISIBILITY = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
  const COMMENTS_BUTTON_LABELS = new Set(["comentarios", "comments"]);
  const NEXT_ENDPOINT = "https://www.youtube.com/youtubei/v1/next?prettyPrint=false";
  const API_MAX_PAGES = 40;
  const API_MAX_REPLY_PAGES = 10;
  const API_MAX_REPLY_THREADS = 200;
  const THREAD_SELECTORS = ["ytd-comment-thread-renderer", "ytm-comment-thread-renderer"];
  const TOP_COMMENT_SELECTORS = [
    "#comment ytd-comment-view-model",
    "#comment ytd-comment-renderer",
    "ytd-comment-view-model",
    "ytd-comment-renderer",
    "#comment ytm-comment-renderer",
    "ytm-comment-renderer",
  ];
  const REPLY_NODE_SELECTORS = [
    "#replies #contents > ytd-comment-view-model, #replies #contents > ytd-comment-renderer, #replies #expanded-threads ytd-comment-view-model, #replies #expanded-threads ytd-comment-renderer",
    "#replies ytd-comment-view-model, #replies ytd-comment-renderer",
    "#replies #contents > ytm-comment-renderer, #replies #expanded-threads ytm-comment-renderer",
    "#replies ytm-comment-renderer",
  ];
  const ANY_COMMENT_SELECTORS = [
    "ytd-comment-view-model",
    "ytd-comment-renderer",
    "yt-comment-view-model",
    "ytm-comment-renderer",
  ];
  const extractionState = {
    phase: "idle",
    runId: null,
    stage: null,
    commentsSeen: 0,
    visibleCommentCount: 0,
    expectedCommentCount: null,
    skipRequestedStage: null,
    result: null,
    error: null,
    activeToken: 0,
  };

  function getStateSnapshot() {
    return {
      phase: extractionState.phase,
      runId: extractionState.runId,
      stage: extractionState.stage,
      commentsSeen: extractionState.commentsSeen,
      visibleCommentCount: extractionState.visibleCommentCount,
      expectedCommentCount: extractionState.expectedCommentCount,
      skipRequestedStage: extractionState.skipRequestedStage,
      result: extractionState.result,
      error: extractionState.error,
    };
  }

  function resetExtractionState() {
    extractionState.phase = "idle";
    extractionState.runId = null;
    extractionState.stage = null;
    extractionState.commentsSeen = 0;
    extractionState.visibleCommentCount = 0;
    extractionState.expectedCommentCount = null;
    extractionState.skipRequestedStage = null;
    extractionState.result = null;
    extractionState.error = null;
  }

  function cancelActiveExtraction() {
    extractionState.activeToken += 1;
    delete window.__YT_COMMENTS__;
    resetExtractionState();
  }

  function ensureActiveRun(token) {
    if (token !== extractionState.activeToken) {
      throw new Error("Extracao cancelada ou reiniciada.");
    }
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

    if (typeof details.expectedCommentCount === "number") {
      extractionState.expectedCommentCount = details.expectedCommentCount;
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

  function getVideoIdFromUrl(href) {
    return String(href || "").match(/[?&]v=([^&#]+)/)?.[1] || null;
  }

  function getVideoMeta() {
    const videoId = getVideoIdFromUrl(location.href);

    return {
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : location.href,
      videoId,
      title: text(document.querySelector("ytd-watch-metadata h1")) || document.title,
    };
  }

  function getExpectedCommentCount() {
    const header = document.querySelector(COMMENTS_COUNT_SELECTOR);
    if (!header?.querySelector) return null;

    const label =
      text(header.querySelector("#count")) ||
      header.querySelector("h2[aria-label]")?.getAttribute?.("aria-label") ||
      "";

    return core.parseCommentCountLabel(label);
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
    const label = normalizeLabel(`${text(button)} ${button.getAttribute("aria-label") || ""}`);
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
    const topNode = getTopCommentNode(thread);
    const selectors = [
      "button[aria-label*='respost' i]",
      "button[aria-label*='reply' i]",
      "tp-yt-paper-button[aria-label*='respost' i]",
      "tp-yt-paper-button[aria-label*='reply' i]",
      "[role='button'][aria-label*='respost' i]",
      "[role='button'][aria-label*='reply' i]",
      "yt-button-shape button",
      "button-view-model button",
      "#more-replies button",
      "#more-replies tp-yt-paper-button",
      "#more-replies-sub-thread button",
      "#more-replies-sub-thread tp-yt-paper-button",
      "ytd-button-renderer#more-replies button",
      "ytd-button-renderer#more-replies-sub-thread button",
    ];

    let buttonsClicked = 0;
    let threadsExpanded = 0;
    let repliesLoaded = 0;
    let threadExpanded = false;
    const seen = new Set();

    for (const selector of selectors) {
      for (const button of qsa(thread, selector)) {
        if (seen.has(button)) continue;
        seen.add(button);

        if (!isReplyExpansionButton(button)) continue;
        if (!isInteractableButton(button)) continue;

        try {
          const repliesBefore = getVisibleReplyNodes(thread, topNode).length;
          button.scrollIntoView?.({ block: "center", behavior: "instant" });
          await wait(150);
          button.click();
          buttonsClicked++;
          const repliesAfter = await waitForReplyChange(thread, topNode, repliesBefore);

          if (repliesAfter > repliesBefore) {
            repliesLoaded += repliesAfter - repliesBefore;
            if (!threadExpanded) {
              threadsExpanded++;
              threadExpanded = true;
            }
          }
        } catch {
          // Ignore stale YouTube nodes while the page rerenders.
        }
      }
    }

    return { buttonsClicked, threadsExpanded, repliesLoaded };
  }

  function getCommentThreads() {
    const threads = uniqueNodes(THREAD_SELECTORS.flatMap((selector) => qsa(document, selector)));

    return dedupeThreadsByCommentId(
      threads.filter((thread) => {
        const topNode = getTopCommentNode(thread);
        return !isNestedReplyThread(thread, topNode);
      })
    );
  }

  function dedupeThreadsByCommentId(threads) {
    const seenCommentIds = new Set();

    return threads.filter((thread) => {
      const commentId = getThreadCommentId(thread, getTopCommentNode(thread));
      if (!commentId) return true;
      if (seenCommentIds.has(commentId)) return false;
      seenCommentIds.add(commentId);
      return true;
    });
  }

  function hasCommentThreads(node) {
    return THREAD_SELECTORS.some((selector) => Boolean(node?.querySelector?.(selector)));
  }

  function findCommentsPanel() {
    return document.querySelector(COMMENTS_PANEL_SELECTOR);
  }

  function findCommentsContainer() {
    const candidates = [
      document.querySelector(INLINE_COMMENTS_SELECTOR),
      findCommentsPanel(),
    ].filter(Boolean);

    return (
      candidates.find((node) => hasCommentThreads(node)) ||
      candidates.find((node) => Boolean(node.clientHeight)) ||
      candidates[0] ||
      null
    );
  }

  function findCommentsQuickActionButton() {
    return (
      qsa(document, "button").find((button) => {
        if (!isInteractableButton(button)) return false;
        return COMMENTS_BUTTON_LABELS.has(normalizeLabel(button.getAttribute?.("aria-label")));
      }) || null
    );
  }

  function isScrollableNode(node) {
    if (!node || node.scrollHeight <= node.clientHeight) return false;

    const style = globalThis.getComputedStyle?.(node);
    if (!style) return true;

    return /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
  }

  function getCommentsScrollers(container) {
    if (!container?.closest?.(COMMENTS_PANEL_SELECTOR)) return [];

    const scrollers = [];
    let current = container;

    while (current && current !== document.body) {
      if (isScrollableNode(current)) scrollers.push(current);
      current = current.parentElement;
    }

    for (const node of container.querySelectorAll?.("*") || []) {
      if (isScrollableNode(node)) scrollers.push(node);
    }

    return scrollers;
  }

  async function waitForCommentThreads(timeoutMs = 3000) {
    const attempts = Math.max(1, Math.ceil(timeoutMs / 500));

    for (let index = 0; index < attempts; index++) {
      if (getCommentThreads().length) return true;
      await wait(500);
    }

    return false;
  }

  function isVisibleNode(node) {
    if (!node) return false;
    if (node.hidden) return false;
    if (node.getAttribute?.("hidden") !== null) return false;
    return true;
  }

  function isInteractableButton(button) {
    if (!isVisibleNode(button)) return false;
    if (button.disabled) return false;
    if (button.getAttribute?.("aria-disabled") === "true") return false;
    if (button.closest?.("[hidden], [aria-hidden='true']")) return false;
    return true;
  }

  function getTopCommentNode(thread) {
    return queryFirst(thread, TOP_COMMENT_SELECTORS);
  }

  function isNestedReplyThread(thread, topNode = getTopCommentNode(thread)) {
    if (!thread) return false;
    if (thread.closest?.("#replies, ytd-comment-replies-renderer")) return true;
    return Boolean(topNode?.closest?.("#replies, ytd-comment-replies-renderer"));
  }

  function getVisibleReplyNodes(thread, topNode = getTopCommentNode(thread)) {
    const candidates = [
      ...REPLY_NODE_SELECTORS.flatMap((selector) => qsa(thread, selector)),
      ...ANY_COMMENT_SELECTORS.flatMap((selector) => qsa(thread, selector)),
    ];

    return uniqueNodes(candidates).filter(
      (replyNode) => replyNode !== topNode && isVisibleNode(replyNode)
    );
  }

  function dedupeReplyNodes(replyNodes) {
    const seenCommentIds = new Set();

    return replyNodes.filter((replyNode) => {
      const commentId = getCommentIdFromNode(replyNode);
      if (!commentId) return true;
      if (seenCommentIds.has(commentId)) return false;
      seenCommentIds.add(commentId);
      return true;
    });
  }

  async function waitForReplyChange(thread, topNode, repliesBefore, timeoutMs = 1500) {
    const attempts = Math.max(1, Math.ceil(timeoutMs / 50));

    for (let index = 0; index < attempts; index++) {
      const repliesAfter = getVisibleReplyNodes(thread, topNode).length;
      if (repliesAfter > repliesBefore) return repliesAfter;
      await wait(50);
    }

    return getVisibleReplyNodes(thread, topNode).length;
  }

  function countVisibleComments(threads = getCommentThreads()) {
    return threads.reduce((sum, thread) => {
      const topNode = getTopCommentNode(thread);
      const replyNodes = getVisibleReplyNodes(thread, topNode);

      return sum + (isVisibleNode(topNode) ? 1 : 0) + replyNodes.length;
    }, 0);
  }

  async function openCommentsPanel() {
    const panel = findCommentsPanel();
    if (panel?.getAttribute?.("visibility") === PANEL_EXPANDED_VISIBILITY) return Boolean(panel);

    const quickActionButton = findCommentsQuickActionButton();
    if (!quickActionButton) return Boolean(panel);

    try {
      quickActionButton.click();
    } catch {
      return Boolean(panel);
    }

    await waitForCommentThreads(3000);

    return true;
  }

  async function ensureCommentsVisible() {
    if (document.querySelector(INLINE_COMMENTS_SELECTOR)) return;

    await openCommentsPanel();
  }

  async function rescueCommentsLoading(token) {
    await openCommentsPanel();
    ensureActiveRun(token);

    for (let index = 0; index < 3; index++) {
      for (const scroller of getCommentsScrollers(findCommentsPanel())) {
        scroller.scrollTop = scroller.scrollHeight;
      }

      await wait(900);
      if (getCommentThreads().length) return;
    }
  }

  async function moveToCommentsSection() {
    await ensureCommentsVisible();
    const container = findCommentsContainer();

    try {
      container?.scrollIntoView?.({ block: "start", behavior: "instant" });
    } catch {
      container?.scrollIntoView?.();
    }

    await wait(900);
    await waitForCommentThreads(1500);
  }

  async function scrollToPageEnd() {
    const scrollers = getCommentsScrollers(findCommentsContainer());

    if (scrollers.length) {
      for (const scroller of scrollers) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    } else {
      window.scrollTo(0, document.documentElement.scrollHeight);
    }

    await wait(900);
  }

  function getStableRoundsLimit(expectedCommentCount, loadedCount) {
    if (!expectedCommentCount || loadedCount >= expectedCommentCount) return 2;

    return 5;
  }

  async function autoScrollComments(maxRounds = 12, runId = null, token = extractionState.activeToken) {
    ensureActiveRun(token);
    await moveToCommentsSection();

    for (let index = 0; index < 3; index++) {
      ensureActiveRun(token);
      await scrollToPageEnd();
    }

    let lastCount = 0;
    let stableRounds = 0;
    let mappedThreads = getCommentThreads();

    if (!mappedThreads.length) {
      await rescueCommentsLoading(token);
      mappedThreads = getCommentThreads();
    }

    const expectedCommentCount = getExpectedCommentCount();
    reportProgress("scroll", {
      runId,
      round: 0,
      maxRounds,
      commentsSeen: mappedThreads.length,
      visibleCommentCount: countVisibleComments(mappedThreads),
      expectedCommentCount,
    });

    for (let index = 0; index < maxRounds; index++) {
      ensureActiveRun(token);
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
        expectedCommentCount,
      });

      if (expectedCommentCount && count >= expectedCommentCount) break;
      if (stableRounds >= getStableRoundsLimit(expectedCommentCount, count)) break;
    }

    ensureActiveRun(token);
    return mappedThreads;
  }

  async function expandAllReplies(maxPasses = 4, runId = null, token = extractionState.activeToken) {
    let emptyPasses = 0;

    for (let pass = 0; pass < maxPasses; pass++) {
      ensureActiveRun(token);
      if (extractionState.skipRequestedStage === "replies") {
        extractionState.skipRequestedStage = null;
        break;
      }

      const threads = getCommentThreads();
      let buttonsClicked = 0;
      let threadsExpanded = 0;
      let repliesLoaded = 0;
      for (const thread of threads) {
        ensureActiveRun(token);
        const result = await clickAllReplyButtons(thread);
        buttonsClicked += result.buttonsClicked;
        threadsExpanded += result.threadsExpanded;
        repliesLoaded += result.repliesLoaded;
      }

      reportProgress("replies", {
        runId,
        pass: pass + 1,
        maxPasses,
        buttonsClicked,
        threadsExpanded,
        repliesLoaded,
        visibleCommentCount: countVisibleComments(threads),
      });

      const loadedNothing = threadsExpanded === 0 && repliesLoaded === 0;
      emptyPasses = loadedNothing ? emptyPasses + 1 : 0;

      if (emptyPasses >= 2) break;
      await wait(loadedNothing ? 1200 : 150);
    }
  }

  function describeReplyControls(thread) {
    const controls = [];
    const seen = new Set();

    for (const selector of ["button", "[role='button']", "tp-yt-paper-button"]) {
      for (const node of qsa(thread, selector)) {
        if (seen.has(node)) continue;
        seen.add(node);

        controls.push({
          tag: node.tagName?.toLowerCase?.() || null,
          id: node.id || null,
          label: normalizeLabel(node.getAttribute?.("aria-label") || text(node)).slice(0, 90),
        });
      }
    }

    return controls.slice(0, 15);
  }

  function collect(threads = getCommentThreads(), includeDebugPaths = false) {
    const data = threads.map((thread, index) => {
      const topNode = getTopCommentNode(thread);

      const topComment = topNode
        ? parseCommentNode(topNode, getThreadCommentId(thread, topNode), includeDebugPaths)
        : { commentId: getThreadCommentId(thread, null) };

      const replyNodes = dedupeReplyNodes(getVisibleReplyNodes(thread, topNode));

      const replies = replyNodes.map((replyNode) =>
        parseCommentNode(replyNode, null, includeDebugPaths)
      );

      const record = core.buildCommentRecord(topComment, replies, index);

      if (includeDebugPaths) {
        record.debugReplyControls = describeReplyControls(thread);
      }

      return record;
    });

    return {
      ...getVideoMeta(),
      collectedAt: new Date().toISOString(),
      mode: "crawler",
      totalThreads: data.length,
      totalReplies: data.reduce((sum, comment) => sum + comment.repliesCount, 0),
      visibleCommentCount: countVisibleComments(threads),
      expectedCommentCount: getExpectedCommentCount(),
      data,
    };
  }

  async function fetchInnertubeNext(api, continuation) {
    const headers = {
      "Content-Type": "application/json",
      "X-Youtube-Client-Name": "1",
    };

    if (api.clientVersion) {
      headers["X-Youtube-Client-Version"] = String(api.clientVersion);
    }

    const response = await fetch(NEXT_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({ context: api.context, continuation }),
    });

    if (!response?.ok) {
      throw new Error(`O YouTube recusou a requisicao (status ${response?.status ?? "?"}).`);
    }

    return response.json();
  }

  async function requestPageApiContext() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "YT_COMMENTS_PAGE_CONTEXT" });
      return response?.api || null;
    } catch {
      return null;
    }
  }

  async function resolveApiContext(api, token) {
    if (api?.continuationToken && api?.context) return api;

    await moveToCommentsSection();
    ensureActiveRun(token);
    const refreshed = await requestPageApiContext();

    return refreshed?.continuationToken && refreshed?.context ? refreshed : null;
  }

  async function loadApiComments(api, runId, token, maxPages = API_MAX_PAGES) {
    const comments = [];
    const seenCommentIds = new Set();
    let continuation = api.continuationToken;
    let truncated = false;

    for (let page = 0; page < maxPages && continuation; page++) {
      ensureActiveRun(token);
      const parsed = core.parseCommentsResponse(await fetchInnertubeNext(api, continuation));

      if (parsed.targetId?.startsWith("comment-replies-item-")) {
        throw new Error("A paginacao de comentarios recebeu um token de respostas.");
      }

      for (const comment of parsed.comments) {
        if (comment.commentId && seenCommentIds.has(comment.commentId)) continue;
        if (comment.commentId) seenCommentIds.add(comment.commentId);
        comments.push(comment);
      }

      continuation = parsed.continuationToken;
      truncated = Boolean(continuation) && page + 1 >= maxPages;
      reportProgress("scroll", {
        runId,
        source: "api",
        round: page + 1,
        maxRounds: maxPages,
        commentsSeen: comments.length,
        expectedCommentCount: getExpectedCommentCount(),
      });
    }

    return { comments, truncated };
  }

  function getPageChannelId() {
    return document.querySelector('meta[itemprop="channelId"]')?.content || null;
  }

  function getThreadRepliesToken(api, comment) {
    if (comment.repliesContinuationToken) {
      return { token: comment.repliesContinuationToken, source: "server" };
    }

    return {
      token: core.buildRepliesContinuationToken({
        videoId: getVideoIdFromUrl(location.href),
        commentId: comment.commentId,
        channelId: api.videoChannelId || getPageChannelId(),
      }),
      source: "built",
    };
  }

  async function loadThreadReplies(api, comment) {
    const { token: continuation } = getThreadRepliesToken(api, comment);

    if (!continuation) return { loaded: 0, truncated: false };

    const seenReplyIds = new Set(comment.replies.map((reply) => reply.commentId).filter(Boolean));
    let loaded = 0;
    let next = continuation;

    for (let page = 0; page < API_MAX_REPLY_PAGES && next; page++) {
      const parsed = core.parseCommentsResponse(await fetchInnertubeNext(api, next));

      for (const reply of parsed.comments) {
        if (reply.commentId && seenReplyIds.has(reply.commentId)) continue;
        if (reply.commentId) seenReplyIds.add(reply.commentId);
        comment.replies.push(reply);
        loaded++;
      }

      next = parsed.continuationToken;
    }

    return { loaded, truncated: Boolean(next) };
  }

  function hasThreadReplies(comment) {
    if (comment.repliesContinuationToken) return true;
    if (typeof comment.replyCount === "number") return comment.replyCount > 0;

    return true;
  }

  async function loadApiReplies(api, comments, runId, token, maxThreads = API_MAX_REPLY_THREADS) {
    const stats = {
      serverTokens: 0,
      builtTokens: 0,
      withoutToken: 0,
      failedThreads: 0,
      attemptedThreads: 0,
    };
    let repliesLoaded = 0;
    let truncated = false;

    for (const comment of comments) {
      ensureActiveRun(token);
      if (!comment.commentId || !hasThreadReplies(comment)) continue;

      if (stats.attemptedThreads >= maxThreads) {
        truncated = true;
        break;
      }

      const { token: repliesToken, source } = getThreadRepliesToken(api, comment);

      if (!repliesToken) {
        stats.withoutToken++;
        continue;
      }

      stats.attemptedThreads++;
      stats[source === "server" ? "serverTokens" : "builtTokens"]++;

      try {
        const threadReplies = await loadThreadReplies(api, comment);

        repliesLoaded += threadReplies.loaded;
        truncated = truncated || threadReplies.truncated;
      } catch (error) {
        if (token !== extractionState.activeToken) throw error;

        stats.failedThreads++;
        console.warn(
          "[YT Comments Extractor] Falha ao carregar as respostas de um comentario.",
          error
        );
      }

      reportProgress("replies", {
        runId,
        source: "api",
        pass: 1,
        maxPasses: 1,
        repliesLoaded,
        failedThreads: stats.failedThreads,
        visibleCommentCount: comments.length + repliesLoaded,
        expectedCommentCount: getExpectedCommentCount(),
      });
    }

    return { repliesLoaded, truncated, stats };
  }

  function toCommentRecord(comment) {
    return {
      commentId: comment.commentId || null,
      author: comment.author || "",
      authorChannelUrl: comment.authorChannelUrl || null,
      content: comment.content || "",
      published: comment.published || "",
      likes: comment.likes || "0",
    };
  }

  function collectFromApiComments(comments, { truncated = false, debug = null } = {}) {
    const data = comments.map((comment, index) =>
      core.buildCommentRecord(
        toCommentRecord(comment),
        (comment.replies || []).map(toCommentRecord),
        index
      )
    );

    return {
      ...getVideoMeta(),
      collectedAt: new Date().toISOString(),
      mode: "api",
      truncated,
      ...(debug ? { debugApi: debug } : {}),
      totalThreads: data.length,
      totalReplies: data.reduce((sum, comment) => sum + comment.repliesCount, 0),
      visibleCommentCount: null,
      expectedCommentCount: getExpectedCommentCount(),
      data,
    };
  }

  async function tryApiExtraction(api, options, runId, token) {
    try {
      const context = await resolveApiContext(api, token);
      if (!context) return null;

      const maxPages = Number(options.maxApiPages ?? API_MAX_PAGES);
      const maxReplyThreads = Number(options.maxReplyThreads ?? API_MAX_REPLY_THREADS);
      const pages = await loadApiComments(context, runId, token, maxPages);
      if (!pages.comments.length) return null;

      const replies = await loadApiReplies(context, pages.comments, runId, token, maxReplyThreads);
      reportProgress("collect", {
        runId,
        source: "api",
        commentsSeen: pages.comments.length,
        expectedCommentCount: getExpectedCommentCount(),
      });

      return collectFromApiComments(pages.comments, {
        truncated: pages.truncated || replies.truncated,
        debug: options.includeDebugPaths
          ? {
              videoChannelId: context.videoChannelId || getPageChannelId(),
              clientVersion: context.clientVersion || null,
              ...replies.stats,
              repliesLoaded: replies.repliesLoaded,
            }
          : null,
      });
    } catch (error) {
      if (token !== extractionState.activeToken) throw error;

      console.warn("[YT Comments Extractor] Modo API indisponivel, voltando para o DOM.", error);
      reportProgress("scroll", {
        runId,
        source: "api",
        fallback: true,
        commentsSeen: 0,
        expectedCommentCount: getExpectedCommentCount(),
      });

      return null;
    }
  }

  function describeCommentsLayout() {
    const container = findCommentsContainer();
    const panel = findCommentsPanel();
    const name =
      container?.id || container?.tagName?.toLowerCase?.() || container?.tagName || "desconhecido";

    return [
      `container: ${container ? name : "nenhum"}`,
      `painel: ${panel ? "sim" : "nao"}`,
      `inline: ${document.querySelector(INLINE_COMMENTS_SELECTOR) ? "sim" : "nao"}`,
      `scrollers: ${getCommentsScrollers(container).length}`,
    ].join(", ");
  }

  async function runDomExtraction(maxScrollRounds, includeDebugPaths, runId, token) {
    await autoScrollComments(maxScrollRounds, runId, token);
    await expandAllReplies(4, runId, token);
    ensureActiveRun(token);
    const liveThreads = getCommentThreads();
    reportProgress("collect", {
      runId,
      commentsSeen: liveThreads.length,
      visibleCommentCount: countVisibleComments(liveThreads),
      expectedCommentCount: getExpectedCommentCount(),
    });
    await wait(1200);
    ensureActiveRun(token);

    return collect(getCommentThreads(), includeDebugPaths);
  }

  async function runExtraction(options = {}) {
    const maxScrollRounds = Number(options.maxScrollRounds ?? 12);
    const runId = options.runId || null;
    const includeDebugPaths = Boolean(options.includeDebugPaths);

    if (extractionState.phase === "running") {
      throw new Error("Uma extracao ja esta em andamento nesta aba.");
    }

    const token = extractionState.activeToken + 1;
    extractionState.activeToken = token;
    extractionState.phase = "running";
    extractionState.runId = runId;
    extractionState.stage = "scroll";
    extractionState.commentsSeen = 0;
    extractionState.visibleCommentCount = 0;
    extractionState.skipRequestedStage = null;
    extractionState.result = null;
    extractionState.error = null;

    const apiResult =
      options.mode === "api" ? await tryApiExtraction(options.api || null, options, runId, token) : null;
    const result =
      apiResult || (await runDomExtraction(maxScrollRounds, includeDebugPaths, runId, token));

    if (result.totalThreads === 0) {
      throw new Error(
        `Nenhum comentario foi encontrado. Aguarde o YouTube carregar os comentarios ou tente aumentar as rodadas de scroll. (${describeCommentsLayout()})`
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

    if (message?.type === "YT_COMMENTS_RESET") {
      cancelActiveExtraction();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type !== "YT_COMMENTS_EXTRACT") return false;

    runExtraction(message.options)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        const errorMessage = error?.message || String(error);
        const wasCancelled = /cancelada|reiniciada/i.test(errorMessage);

        if (!wasCancelled) {
          extractionState.phase = "error";
          extractionState.stage = extractionState.stage || "scroll";
          extractionState.skipRequestedStage = null;
          extractionState.error = errorMessage;
        }

        sendResponse({
          ok: false,
          error: errorMessage,
        });
      });

    return true;
  });
})();
