# Shorts Comments Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every comment thread and reply of the Short currently in the URL, using the existing API-first pipeline and DOM fallback.

**Architecture:** Treat `/shorts/VIDEO_ID` as a video page. Pin `videoId` at run start. Reuse `/youtubei/v1/next` after reading the continuation from the Shorts comments engagement panel. Open that panel with the “Ver N comentários” action. DOM fallback scrolls the same panel and aborts if the feed advances to another Short.

**Tech Stack:** Chrome extension Manifest V3, content script, popup script, `src/extractor-core.js`, Node test runner (`npm test`)

**Spec:** `docs/superpowers/specs/2026-09-27-shorts-comments-extraction-design.md`

---

## File map

- Modify: `src/extractor-core.js` — URL helpers; Shorts panel `targetId` for continuation tokens
- Modify: `content.js` — pinned video id/url, title, comments action, expected count, DOM abort
- Modify: `popup.js` — accept Shorts URLs; include comments panel in page-context sources
- Modify: `manifest.json` — inject on `/shorts*`
- Modify: `README.md` — Shorts URLs
- Modify: `test/extractor-core.test.js`
- Modify: `test/popup.test.js`
- Modify: `test/content.test.js`

Do not add `reel_item_watch` as a comments pager. Do not change comment/reply JSON fields.

Working tree may already have unrelated edits in `content.js` and `test/content.test.js`. Commit only files touched by the current task.

---

### Task 1: Continuation token on the Shorts comments panel

**Files:**
- Modify: `test/extractor-core.test.js`
- Modify: `src/extractor-core.js`

- [ ] **Step 1: Write the failing test**

Add to `test/extractor-core.test.js` after the existing `findCommentsContinuationToken` tests:

```javascript
test("findCommentsContinuationToken reads the Shorts engagement panel", () => {
  const data = {
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          targetId: "engagement-panel-structured-description",
          contents: [createContinuationItem("DESCRIPTION_TOKEN")],
        },
      },
      {
        engagementPanelSectionListRenderer: {
          targetId: "engagement-panel-comments-section",
          contents: [
            { commentsHeaderRenderer: { countText: { simpleText: "2576" } } },
            createContinuationItem("SHORTS_COMMENTS_TOKEN"),
          ],
        },
      },
    ],
  };

  assert.equal(findCommentsContinuationToken(data), "SHORTS_COMMENTS_TOKEN");
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test test/extractor-core.test.js`

Expected: FAIL — `findCommentsContinuationToken` returns `null` or `DESCRIPTION_TOKEN`, not `SHORTS_COMMENTS_TOKEN`.

- [ ] **Step 3: Accept the Shorts panel target id**

In `src/extractor-core.js`, inside `findCommentsContinuationToken`, replace the host check:

```javascript
    const isCommentsHost =
      data.sectionIdentifier === "comment-item-section" ||
      data.targetId === "comments-section" ||
      data.targetId === "engagement-panel-comments-section";

    if (isCommentsHost) {
      const token = findContinuationItemToken(data.contents) || findContinuationToken(data);
      if (token) return token;
    }
```

- [ ] **Step 4: Re-run the core tests**

Run: `node --test test/extractor-core.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/extractor-core.test.js src/extractor-core.js
git commit -m "Read comment continuation tokens from the Shorts panel."
```

---

### Task 2: Video URL helpers in extractor-core

**Files:**
- Modify: `test/extractor-core.test.js`
- Modify: `src/extractor-core.js`

- [ ] **Step 1: Write failing URL helper tests**

Add to `test/extractor-core.test.js`. Import the new functions in the existing `require("../src/extractor-core")` destructure: `getVideoIdFromUrl`, `getCanonicalVideoUrl`.

```javascript
test("getVideoIdFromUrl reads watch and Shorts ids", () => {
  assert.equal(getVideoIdFromUrl("https://www.youtube.com/watch?v=abc123XYZ_1"), "abc123XYZ_1");
  assert.equal(
    getVideoIdFromUrl("https://www.youtube.com/watch?v=abc123XYZ_1&list=PL123&t=42s"),
    "abc123XYZ_1"
  );
  assert.equal(getVideoIdFromUrl("https://www.youtube.com/shorts/CnTnVrfO348"), "CnTnVrfO348");
  assert.equal(getVideoIdFromUrl("https://m.youtube.com/shorts/CnTnVrfO348?si=abc"), "CnTnVrfO348");
  assert.equal(getVideoIdFromUrl("https://www.youtube.com/feed/subscriptions"), null);
});

test("getCanonicalVideoUrl keeps Shorts and watch URLs distinct", () => {
  assert.equal(
    getCanonicalVideoUrl("https://www.youtube.com/watch?v=abc123&list=PL123&t=42s"),
    "https://www.youtube.com/watch?v=abc123"
  );
  assert.equal(
    getCanonicalVideoUrl("https://www.youtube.com/shorts/CnTnVrfO348?si=abc"),
    "https://www.youtube.com/shorts/CnTnVrfO348"
  );
  assert.equal(
    getCanonicalVideoUrl("https://m.youtube.com/shorts/CnTnVrfO348"),
    "https://www.youtube.com/shorts/CnTnVrfO348"
  );
});

test("parseCommentCountLabel reads the Shorts comments action count", () => {
  assert.equal(parseCommentCountLabel("Ver 2.576 comentários"), 2576);
  assert.equal(parseCommentCountLabel("View 2,576 comments"), 2576);
  assert.equal(parseCommentCountLabel("Comentários 2,5 mil"), 2500);
});
```

- [ ] **Step 2: Run the new tests and confirm URL helpers fail**

Run: `node --test test/extractor-core.test.js`

Expected: FAIL on missing exports `getVideoIdFromUrl` / `getCanonicalVideoUrl`. The `parseCommentCountLabel` cases may already pass.

- [ ] **Step 3: Implement the helpers**

In `src/extractor-core.js`, add next to `normalizeText`:

```javascript
  function getVideoIdFromUrl(href) {
    const value = String(href || "");

    return value.match(/\/shorts\/([^/?&#]+)/)?.[1] || value.match(/[?&]v=([^&#]+)/)?.[1] || null;
  }

  function getCanonicalVideoUrl(href) {
    const videoId = getVideoIdFromUrl(href);
    if (!videoId) return String(href || "");

    if (/\/shorts\//.test(String(href || ""))) {
      return `https://www.youtube.com/shorts/${videoId}`;
    }

    return `https://www.youtube.com/watch?v=${videoId}`;
  }
```

Export them from the returned object:

```javascript
    getCanonicalVideoUrl,
    getVideoIdFromUrl,
```

- [ ] **Step 4: Re-run the core tests**

Run: `node --test test/extractor-core.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/extractor-core.test.js src/extractor-core.js
git commit -m "Parse watch and Shorts video URLs in extractor-core."
```

---

### Task 3: Popup accepts Shorts pages

**Files:**
- Modify: `test/popup.test.js`
- Modify: `popup.js`

- [ ] **Step 1: Let the popup harness choose the active tab URL**

In `test/popup.test.js`, change `createPopupHarness` to take `tabUrl`:

```javascript
function createPopupHarness({ initialStatus, apiContext, tabUrl } = {}) {
```

In `chrome.tabs.query`:

```javascript
        async query() {
          return [{ id: 1, url: tabUrl || "https://www.youtube.com/watch?v=test" }];
        },
```

- [ ] **Step 2: Write failing popup URL tests**

```javascript
test("popup starts extraction on a Shorts URL", async () => {
  const { nodes, sentMessages } = createPopupHarness({
    tabUrl: "https://www.youtube.com/shorts/CnTnVrfO348",
  });

  await nodes["#extractButton"].click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(sentMessages.some((message) => message.type === "YT_COMMENTS_EXTRACT"));
});

test("popup rejects a YouTube URL that is not a video", async () => {
  const { nodes, sentMessages } = createPopupHarness({
    tabUrl: "https://www.youtube.com/feed/subscriptions",
  });

  await nodes["#extractButton"].click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    sentMessages.some((message) => message.type === "YT_COMMENTS_EXTRACT"),
    false
  );
  assert.match(nodes["#status"].textContent, /Abra uma pagina de video/);
});
```

- [ ] **Step 3: Run popup tests and confirm Shorts extraction fails**

Run: `node --test test/popup.test.js`

Expected: FAIL — Shorts click never sends `YT_COMMENTS_EXTRACT`.

- [ ] **Step 4: Share one video-URL check in the popup**

Add near the top of `popup.js`:

```javascript
function isYouTubeVideoUrl(href) {
  return /^https:\/\/(www|m)\.youtube\.com\/(watch|shorts\/)/.test(String(href || ""));
}
```

Replace the three copies of:

```javascript
!/^https:\/\/(www|m)\.youtube\.com\/watch/.test(tab.url || "")
```

with:

```javascript
!isYouTubeVideoUrl(tab.url)
```

Places today: `restoreStateFromActiveTab`, extract click handler, reset click handler.

- [ ] **Step 5: Re-run popup tests**

Run: `node --test test/popup.test.js`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add test/popup.test.js popup.js
git commit -m "Allow the popup to extract comments from Shorts pages."
```

---

### Task 4: Inject the content script on Shorts

**Files:**
- Modify: `test/popup.test.js` (or `test/content.test.js` if you prefer a dedicated manifest assertion)
- Modify: `manifest.json`

- [ ] **Step 1: Write a failing manifest test**

Add to `test/popup.test.js` (it already imports `fs` and `path`):

```javascript
test("manifest injects the content script on Shorts pages", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const matches = manifest.content_scripts[0].matches;

  assert.ok(matches.includes("https://www.youtube.com/watch*"));
  assert.ok(matches.includes("https://m.youtube.com/watch*"));
  assert.ok(matches.includes("https://www.youtube.com/shorts*"));
  assert.ok(matches.includes("https://m.youtube.com/shorts*"));
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test test/popup.test.js`

Expected: FAIL — Shorts matches missing.

- [ ] **Step 3: Add the matches**

In `manifest.json` `content_scripts[0].matches`:

```json
      "matches": [
        "https://www.youtube.com/watch*",
        "https://m.youtube.com/watch*",
        "https://www.youtube.com/shorts*",
        "https://m.youtube.com/shorts*"
      ],
```

- [ ] **Step 4: Re-run popup tests**

Run: `node --test test/popup.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/popup.test.js manifest.json
git commit -m "Inject the content script on YouTube Shorts pages."
```

---

### Task 5: Pin Shorts video meta in the content script

**Files:**
- Modify: `test/content.test.js`
- Modify: `content.js`

- [ ] **Step 1: Extend the content harness with extra query nodes**

In `loadContentScript`, add `queryMap = {}` and `queryAllMap = {}` to the options. At the top of `document.querySelector`:

```javascript
        if (Object.prototype.hasOwnProperty.call(queryMap, selector)) {
          return queryMap[selector];
        }
```

At the top of `document.querySelectorAll`:

```javascript
        if (Object.prototype.hasOwnProperty.call(queryAllMap, selector)) {
          return queryAllMap[selector];
        }
```

- [ ] **Step 2: Write failing Shorts meta tests**

```javascript
test("content extraction stores the canonical Shorts url, id and title", async () => {
  const { listener, sandbox } = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
    queryMap: {
      "ytd-watch-metadata h1": null,
      h1: createElement({ innerText: "Harvard Mindset to Never Waste Another Second Again" }),
    },
  });
  sandbox.location.href = "https://www.youtube.com/shorts/CnTnVrfO348?si=abc";

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "shorts-meta-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.videoId, "CnTnVrfO348");
  assert.equal(response.result.url, "https://www.youtube.com/shorts/CnTnVrfO348");
  assert.equal(response.result.title, "Harvard Mindset to Never Waste Another Second Again");
});

test("content API replies keep the pinned Shorts video id after the feed advances", async () => {
  const requests = [];
  const fetchImpl = createFetchStub(
    [
      createApiPage([createApiThreadItem({ commentId: "UgxNoToken", content: "Sem token" })]),
      createApiPage([createApiReplyItem("UgxBuiltReply", "Resposta via token construido")]),
    ],
    requests
  );
  const { listener, sandbox } = loadContentScript({ commentThreads: [], fetchImpl });
  sandbox.location.href = "https://www.youtube.com/shorts/CnTnVrfO348";

  const extraction = sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: {
      mode: "api",
      api: { context: {}, continuationToken: "PAGE_1", videoChannelId: "UCowner" },
      runId: "pinned-shorts-api-run",
    },
  });

  sandbox.location.href = "https://www.youtube.com/shorts/OTHERVID123";
  const response = await extraction;

  assert.equal(response.ok, true);
  assert.equal(response.result.videoId, "CnTnVrfO348");
  assert.equal(response.result.url, "https://www.youtube.com/shorts/CnTnVrfO348");
  assert.equal(
    requests[1],
    core.buildRepliesContinuationToken({
      videoId: "CnTnVrfO348",
      commentId: "UgxNoToken",
      channelId: "UCowner",
    })
  );
});
```

Put the Shorts meta test next to `content extraction stores the canonical video url and id`. Put the API pin test with the other API tests, after `createFetchStub` is defined.

Keep the existing watch canonical-url test. It must still expect `https://www.youtube.com/watch?v=abc123`.

- [ ] **Step 3: Run the content tests and confirm the new ones fail**

Run: `node --test test/content.test.js`

Expected: FAIL — `videoId` is null on `/shorts/`, URL is still built as `/watch?v=`, built replies token uses `test` or the new Short id.

- [ ] **Step 4: Pin video id/url and use core helpers**

In `content.js`:

1. Add `videoId` and `pageUrl` to `extractionState` (start as `null`). Clear them in `resetExtractionState`.

2. Replace the local `getVideoIdFromUrl` with:

```javascript
  function getVideoIdFromUrl(href) {
    return core.getVideoIdFromUrl(href);
  }

  function pinVideoFromLocation() {
    extractionState.videoId = core.getVideoIdFromUrl(location.href);
    extractionState.pageUrl = core.getCanonicalVideoUrl(location.href);
  }

  function getPinnedVideoId() {
    return extractionState.videoId || core.getVideoIdFromUrl(location.href);
  }
```

3. Replace `getVideoMeta`:

```javascript
  function getVideoMeta() {
    const videoId = getPinnedVideoId();

    return {
      url: extractionState.pageUrl || core.getCanonicalVideoUrl(location.href),
      videoId,
      title:
        text(document.querySelector("ytd-watch-metadata h1")) ||
        text(document.querySelector("h1")) ||
        document.title,
    };
  }
```

4. At the start of `runExtraction`, after setting `extractionState.phase = "running"`:

```javascript
    pinVideoFromLocation();
```

5. In `fetchVideoChannelId` and `getThreadRepliesToken`, pass `getPinnedVideoId()` instead of `getVideoIdFromUrl(location.href)`.

- [ ] **Step 5: Re-run content tests**

Run: `node --test test/content.test.js`

Expected: the new meta/pin tests PASS. Existing watch canonical-url test still PASS.

- [ ] **Step 6: Commit**

```bash
git add test/content.test.js content.js
git commit -m "Pin Shorts video id, url and title for each extraction run."
```

---

### Task 6: Open Shorts comments with the view-comments action

**Files:**
- Modify: `test/content.test.js`
- Modify: `content.js`

- [ ] **Step 1: Write failing button tests**

```javascript
test("content extraction opens Shorts comments from the view-comments action", async () => {
  let commentsClicks = 0;
  let sortClicks = 0;
  const thread = createStructuredThread({ topNode: createCommentTopNode({ commentId: "UgwShorts" }) });
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
    scrollIntoView() {},
  });
  const commentsButton = createElement({
    getAttribute(name) {
      return name === "aria-label" ? "Ver 2.576 comentários" : null;
    },
    click() {
      commentsClicks++;
    },
  });
  const sortButton = createElement({
    getAttribute(name) {
      return name === "aria-label" ? "Classificar comentários" : null;
    },
    click() {
      sortClicks++;
    },
  });
  const { listener } = loadContentScript({
    commentThreads: [thread],
    commentsPanel: panel,
    quickActionButtons: [sortButton, commentsButton],
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 1, runId: "shorts-open-comments-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(commentsClicks, 1);
  assert.equal(sortClicks, 0);
});
```

Keep the existing test that clicks `aria-label: "Comentários"`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test --test-name-pattern="view-comments" test/content.test.js`

Expected: FAIL — `commentsClicks` stays `0` because the label is not exactly `comentarios`.

- [ ] **Step 3: Match view-comments labels and ignore sort**

Replace `findCommentsQuickActionButton` in `content.js` with:

```javascript
  function isCommentsSortLabel(label) {
    return /\b(classificar|sort|ordenar)\b/.test(label);
  }

  function isCommentsOpenLabel(label) {
    if (!label || isCommentsSortLabel(label)) return false;
    if (COMMENTS_BUTTON_LABELS.has(label)) return true;

    return (
      (/\bver\b/.test(label) && /comentari/.test(label)) ||
      (/\bview\b/.test(label) && /\bcomments?\b/.test(label))
    );
  }

  function findCommentsQuickActionButton() {
    return (
      qsa(document, "button").find((button) => {
        if (!isInteractableButton(button)) return false;
        const label = normalizeLabel(
          `${text(button)} ${button.getAttribute?.("aria-label") || ""}`
        );
        return isCommentsOpenLabel(label);
      }) || null
    );
  }
```

- [ ] **Step 4: Re-run the panel tests**

Run: `node --test --test-name-pattern="comments panel|view-comments" test/content.test.js`

Expected: PASS, including the original `Comentários` panel test.

- [ ] **Step 5: Commit**

```bash
git add test/content.test.js content.js
git commit -m "Open the Shorts comments panel from the view-comments action."
```

---

### Task 7: Expected comment count from the Shorts button and heading

**Files:**
- Modify: `test/content.test.js`
- Modify: `content.js`

- [ ] **Step 1: Write failing expected-count tests**

```javascript
test("content extraction prefers the exact Shorts comments button count", async () => {
  const commentsButton = createElement({
    getAttribute(name) {
      return name === "aria-label" ? "Ver 2.576 comentários" : null;
    },
  });
  const heading = createElement({
    getAttribute(name) {
      return name === "aria-label" ? "Comentários 2,5 mil" : null;
    },
  });
  const { listener, progressMessages } = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
    quickActionButtons: [commentsButton],
    queryAllMap: {
      h2: [heading],
      "h2[aria-label]": [heading],
    },
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "shorts-count-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.expectedCommentCount, 2576);
  assert.equal(progressMessages.at(-1).expectedCommentCount, 2576);
});

test("content extraction reads the Shorts comments heading when the button has no number", async () => {
  const heading = createElement({
    getAttribute(name) {
      return name === "aria-label" ? "Comentários 2,5 mil" : null;
    },
    innerText: "Comentários 2,5 mil",
  });
  const { listener } = loadContentScript({
    commentThreads: [createLoadedCommentThread()],
    queryAllMap: {
      h2: [heading],
      "h2[aria-label]": [heading],
    },
  });

  const response = await sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { maxScrollRounds: 0, runId: "shorts-heading-count-run" },
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.expectedCommentCount, 2500);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test --test-name-pattern="Shorts comments" test/content.test.js`

Expected: FAIL — `expectedCommentCount` is `null`.

- [ ] **Step 3: Read button, header, then heading**

Replace `getExpectedCommentCount` in `content.js`:

```javascript
  function getCommentsHeadingCount() {
    const headings = [
      ...qsa(document, "h2[aria-label]"),
      ...qsa(document, "h2"),
    ];

    for (const heading of headings) {
      const label = heading.getAttribute?.("aria-label") || text(heading);
      const normalized = normalizeLabel(label);
      if (!/comentari/.test(normalized) && !/\bcomments?\b/.test(normalized)) continue;
      if (isCommentsSortLabel(normalized)) continue;
      const count = core.parseCommentCountLabel(label);
      if (typeof count === "number") return count;
    }

    return null;
  }

  function getExpectedCommentCount() {
    const header = document.querySelector(COMMENTS_COUNT_SELECTOR);
    const headerLabel = header?.querySelector
      ? text(header.querySelector("#count")) ||
        header.querySelector("h2[aria-label]")?.getAttribute?.("aria-label") ||
        ""
      : "";
    const headerCount = core.parseCommentCountLabel(headerLabel);
    const commentsButton = findCommentsQuickActionButton();
    const buttonCount = core.parseCommentCountLabel(
      `${text(commentsButton)} ${commentsButton?.getAttribute?.("aria-label") || ""}`
    );
    const headingCount = getCommentsHeadingCount();

    return buttonCount ?? headerCount ?? headingCount;
  }
```

Watch pages with header `1,2 mil` and a `Comentários` button (no number) still resolve to `1200` via `headerCount`.

- [ ] **Step 4: Re-run expected-count tests**

Run: `node --test --test-name-pattern="comment count|Shorts comments" test/content.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/content.test.js content.js
git commit -m "Read Shorts expected comment counts from the action and heading."
```

---

### Task 8: Abort DOM extraction when the Short changes

**Files:**
- Modify: `test/content.test.js`
- Modify: `content.js`

- [ ] **Step 1: Write the failing test**

```javascript
test("content DOM extraction stops when the Shorts feed advances", async () => {
  const timers = createDeferredTimers();
  const { listener, sandbox } = loadContentScript({
    timers,
    commentThreads: [createLoadedCommentThread()],
  });
  sandbox.location.href = "https://www.youtube.com/shorts/CnTnVrfO348";

  const extraction = sendContentMessage(listener, {
    type: "YT_COMMENTS_EXTRACT",
    options: { mode: "dom", maxScrollRounds: 4, runId: "shorts-feed-advance-run" },
  });

  await timers.flushNext();
  sandbox.location.href = "https://www.youtube.com/shorts/OTHERVID123";
  await timers.flushAll();
  const response = await extraction;

  assert.equal(response.ok, false);
  assert.match(response.error, /Short mudou|Mantenha o Short original/i);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test --test-name-pattern="feed advances" test/content.test.js`

Expected: FAIL — extraction succeeds instead of erroring.

- [ ] **Step 3: Guard DOM loops with the pinned id**

Add in `content.js`:

```javascript
  function ensurePinnedVideo() {
    const currentId = core.getVideoIdFromUrl(location.href);
    if (extractionState.videoId && currentId && currentId !== extractionState.videoId) {
      throw new Error(
        "O Short mudou durante a coleta. Mantenha o Short original aberto e extraia de novo."
      );
    }
  }
```

Call `ensurePinnedVideo()` at the start of each loop body in `autoScrollComments` and `expandAllReplies`, and at the start of `runDomExtraction` after `ensureActiveRun`. Do not call it from the API paging loop.

- [ ] **Step 4: Re-run the feed-advance test and the API pin test**

Run: `node --test --test-name-pattern="pinned Shorts|feed advances" test/content.test.js`

Expected: PASS — DOM errors, API still finishes with the original Short id.

- [ ] **Step 5: Commit**

```bash
git add test/content.test.js content.js
git commit -m "Stop DOM Shorts extraction when the feed advances."
```

---

### Task 9: Read the continuation token from the Shorts panel in page context

**Files:**
- Modify: `test/popup.test.js`
- Modify: `popup.js`

- [ ] **Step 1: Write the failing page-context test**

Reuse `createContinuationItem` shape inline. The popup sandbox must see `YouTubeCommentsExtractorCore`:

```javascript
test("popup page context reads the Shorts comments panel token", () => {
  const core = require("../src/extractor-core");
  const { sandbox } = createPopupHarness();
  const panelData = {
    targetId: "engagement-panel-comments-section",
    contents: [
      {
        continuationItemRenderer: {
          continuationEndpoint: { continuationCommand: { token: "SHORTS_PANEL_TOKEN" } },
        },
      },
    ],
  };

  sandbox.YouTubeCommentsExtractorCore = core;
  sandbox.globalThis.YouTubeCommentsExtractorCore = core;
  sandbox.globalThis.ytInitialData = null;
  sandbox.globalThis.ytcfg = { get() { return null; } };
  const originalQuery = sandbox.document.querySelector.bind(sandbox.document);
  sandbox.document.querySelector = (selector) => {
    if (selector === "ytd-comments") return null;
    if (
      selector ===
      "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-comments-section']"
    ) {
      return { data: panelData };
    }
    if (
      selector ===
      "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-comments-section'] ytd-comments"
    ) {
      return null;
    }
    return originalQuery(selector);
  };

  const api = sandbox.readPageApiContextInPage();

  assert.equal(api.continuationToken, "SHORTS_PANEL_TOKEN");
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test --test-name-pattern="Shorts comments panel token" test/popup.test.js`

Expected: FAIL — `continuationToken` is `null` because the panel itself is not a source.

- [ ] **Step 3: Add the panel data source**

In `popup.js` `readPageApiContextInPage`, set:

```javascript
  const panelSelector =
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-comments-section']";
  const sources = [
    globalThis.ytInitialData,
    document.querySelector("ytd-comments")?.data,
    document.querySelector(panelSelector)?.data,
    document.querySelector(`${panelSelector} ytd-comments`)?.data,
  ];
```

- [ ] **Step 4: Re-run the popup tests**

Run: `node --test test/popup.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/popup.test.js popup.js
git commit -m "Read Shorts comment continuation tokens from the engagement panel."
```

---

### Task 10: README and full suite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document Shorts URLs**

In `README.md` install step 5, mention both watch and Shorts:

```markdown
5. Abra um video em `https://www.youtube.com/watch...` ou um Short em `https://www.youtube.com/shorts...`.
```

After “Modos de extracao”, add:

```markdown
Shorts usam o mesmo fluxo. A coleta vale so para o Short da URL; se o feed avancar no modo DOM, a extensao para e pede para manter o Short original aberto.
```

In “Formato do JSON”, note that `url` is `https://www.youtube.com/shorts/ID` when the page is a Short.

- [ ] **Step 2: Run the full suite**

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document Shorts comment extraction."
```

---

## Spec coverage

| Spec item | Task |
| --- | --- |
| Manifest `/shorts*` | 4 |
| Popup accepts Shorts URLs | 3 |
| `videoId` from `/shorts/ID` | 2, 5 |
| Canonical Shorts `url` | 2, 5 |
| Pin `videoId` for API after feed advance | 5 |
| Title from Short `h1` | 5 |
| Open `Ver N comentários`, ignore sort | 6 |
| Expected count button then heading | 7 |
| Continuation `engagement-panel-comments-section` | 1, 9 |
| Same `/youtubei/v1/next` parser | unchanged (tasks 1, 5) |
| DOM abort when URL videoId changes | 8 |
| Page context includes comments panel | 9 |
| README | 10 |
| Watch tests keep passing | 5, 6, 7, 10 |
| No `reel_item_watch` pager | non-goal, no task |

## Self-review

- No TBD/TODO placeholders.
- `getVideoIdFromUrl` / `getCanonicalVideoUrl` names are the same in core, content, and tests.
- `isYouTubeVideoUrl` lives only in `popup.js` (popup does not load `extractor-core.js`).
- `isCommentsOpenLabel` / `isCommentsSortLabel` names are shared by tasks 6 and 7; implement 6 before 7.
- `pinVideoFromLocation` must run before any `getVideoMeta` / replies token work in the same run.
