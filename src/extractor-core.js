(function attachCore(root, factory) {
  const core = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = core;
  }

  if (root) {
    root.YouTubeCommentsExtractorCore = core;
  }
})(typeof globalThis !== "undefined" ? globalThis : null, function createCore() {
  const COUNT_UNIT_MULTIPLIERS = {
    k: 1000,
    mil: 1000,
    m: 1000000,
    mi: 1000000,
    b: 1000000000,
    bi: 1000000000,
    bilhao: 1000000000,
    "bilhão": 1000000000,
    bilhoes: 1000000000,
    "bilhões": 1000000000,
  };
  const COUNT_UNIT_PATTERN = new RegExp(
    `(\\d+(?:[.,]\\d+)?)\\s*(${Object.keys(COUNT_UNIT_MULTIPLIERS).join("|")})\\b`,
    "i"
  );

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function parseCommentCountLabel(value) {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized) return null;

    const unitMatch = normalized.match(COUNT_UNIT_PATTERN);

    if (unitMatch) {
      const amount = Number(unitMatch[1].replace(",", "."));
      const multiplier = COUNT_UNIT_MULTIPLIERS[unitMatch[2].toLowerCase()] || 1;

      return Number.isFinite(amount) ? Math.round(amount * multiplier) : null;
    }

    const digitsMatch = normalized.match(/\d[\d.,\s]*/);
    const digits = digitsMatch?.[0].replace(/\D/g, "");
    if (!digits) return null;

    const amount = Number(digits);

    return Number.isFinite(amount) ? amount : null;
  }

  function readText(value) {
    if (!value) return "";
    if (typeof value === "string") return normalizeText(value);
    if (typeof value.simpleText === "string") return normalizeText(value.simpleText);
    if (typeof value.content === "string") return normalizeText(value.content);
    if (typeof value.text === "string") return normalizeText(value.text);
    if (Array.isArray(value.runs)) {
      return normalizeText(value.runs.map((run) => run?.text || "").join(""));
    }

    return "";
  }

  function findContinuationToken(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 14) return null;

    const token =
      node.continuationEndpoint?.continuationCommand?.token ||
      node.continuationCommand?.token ||
      node.nextContinuationData?.continuation;

    if (token) return token;

    for (const value of Object.values(node)) {
      const found = findContinuationToken(value, depth + 1);
      if (found) return found;
    }

    return null;
  }

  function hasCommentsHeader(node) {
    if (node.commentsHeaderRenderer) return true;

    return Object.values(node).some((value) => {
      if (!value || typeof value !== "object") return false;
      if (value.commentsHeaderRenderer) return true;
      return Array.isArray(value) && value.some((item) => item?.commentsHeaderRenderer);
    });
  }

  function findContinuationItemToken(items) {
    if (!Array.isArray(items)) return null;

    for (const item of items) {
      if (!item?.continuationItemRenderer) continue;
      const token = findContinuationToken(item);
      if (token) return token;
    }

    return null;
  }

  function findCommentsContinuationToken(data, depth = 0) {
    if (!data || typeof data !== "object" || depth > 14) return null;

    if (data.sectionIdentifier === "comment-item-section" || data.targetId === "comments-section") {
      const token = findContinuationItemToken(data.contents) || findContinuationToken(data);
      if (token) return token;
    }

    if (hasCommentsHeader(data)) {
      const token = findContinuationItemToken(data.contents) || findContinuationToken(data);
      if (token) return token;
    }

    for (const value of Object.values(data)) {
      if (!value || typeof value !== "object") continue;
      const token = findCommentsContinuationToken(value, depth + 1);
      if (token) return token;
    }

    return null;
  }

  function getCommentPayload(entity) {
    if (!entity || typeof entity !== "object") return null;

    return (
      entity.commentRenderer ||
      entity.commentViewModel?.commentViewModel ||
      entity.commentViewModel ||
      (entity.commentId || entity.commentKey ? entity : null)
    );
  }

  function readCommentEntities(payload) {
    const mutations = payload?.frameworkUpdates?.entityBatchUpdate?.mutations;
    const entities = new Map();
    if (!Array.isArray(mutations)) return entities;

    for (const mutation of mutations) {
      const entity = mutation?.payload?.commentEntityPayload;
      if (!entity) continue;

      const properties = entity.properties || {};
      const author = entity.author?.displayName || readText(entity.author?.name);
      const record = {
        commentId: properties.commentId || null,
        author,
        authorChannelUrl:
          entity.author?.channelPageEndpoint?.innertubeCommand?.browseEndpoint?.canonicalBaseUrl ||
          (author.startsWith("@") ? `https://www.youtube.com/${author}` : null),
        content: readText(properties.content),
        published: properties.publishedTime || "",
        likes: readText(entity.toolbar?.likeCountNotliked) || "0",
        replyCount: parseCommentCountLabel(
          entity.toolbar?.replyCount || entity.toolbar?.replyCountA11y || ""
        ),
      };

      if (entity.key) entities.set(entity.key, record);
      if (record.commentId) entities.set(record.commentId, record);
    }

    return entities;
  }

  function findCommentEntity(payload, entities) {
    if (!payload || !entities?.size) return null;

    return entities.get(payload.commentKey) || entities.get(payload.commentId) || null;
  }

  function parseCommentEntity(entity, entities) {
    const payload = getCommentPayload(entity);
    if (!payload) return null;

    const stored = findCommentEntity(payload, entities);
    const content = stored?.content || readText(payload.contentText) || readText(payload.content);
    const commentId = payload.commentId || stored?.commentId || payload.commentKey || null;
    if (!commentId && !content) return null;

    return {
      commentId,
      author: stored?.author || readText(payload.authorText) || readText(payload.authorName),
      authorChannelUrl:
        stored?.authorChannelUrl ||
        payload.authorEndpoint?.browseEndpoint?.canonicalBaseUrl ||
        payload.authorEndpoint?.commandMetadata?.webCommandMetadata?.url ||
        null,
      content,
      published: stored?.published || readText(payload.publishedTimeText),
      likes: stored?.likes || readText(payload.voteCount) || readText(payload.likeCount) || "0",
      replyCount: stored?.replyCount ?? null,
    };
  }

  function getCommentRepliesRenderer(renderer) {
    return renderer?.replies?.commentRepliesRenderer || null;
  }

  function parseReplies(renderer, entities) {
    const items = getCommentRepliesRenderer(renderer)?.contents;
    if (!Array.isArray(items)) return [];

    return items.map((item) => parseCommentEntity(item, entities)).filter(Boolean);
  }

  function parseRepliesContinuationToken(renderer) {
    const repliesRenderer = getCommentRepliesRenderer(renderer);
    if (!repliesRenderer) return null;

    const items = Array.isArray(repliesRenderer.contents) ? repliesRenderer.contents : [];
    const continuationItem = items.find((item) => item?.continuationItemRenderer);

    return (
      findContinuationToken(continuationItem) ||
      findContinuationToken(repliesRenderer.continuations) ||
      null
    );
  }

  function parseCommentThread(thread, entities) {
    const renderer = thread?.commentThreadRenderer || thread;
    const payload = getCommentPayload(renderer?.comment || renderer?.commentViewModel || renderer);
    if (!payload) return null;

    const record = parseCommentEntity(payload, entities);
    if (!record) return null;

    const repliesHost = payload.replies ? payload : renderer;

    return {
      ...record,
      replies: parseReplies(repliesHost, entities),
      repliesContinuationToken: parseRepliesContinuationToken(repliesHost),
    };
  }

  function collectContinuationItems(payload) {
    const items = [];
    const endpoints = Array.isArray(payload?.onResponseReceivedEndpoints)
      ? payload.onResponseReceivedEndpoints
      : [];

    for (const endpoint of endpoints) {
      for (const action of [
        endpoint?.appendContinuationItemsAction,
        endpoint?.reloadContinuationItemsCommand,
      ]) {
        if (Array.isArray(action?.continuationItems)) items.push(...action.continuationItems);
      }
    }

    if (items.length) return items;

    const contents = payload?.continuationContents;
    const legacyItems =
      contents?.commentSectionContinuation?.contents ||
      contents?.commentThreadContinuation?.contents ||
      contents?.commentRepliesContinuation?.contents;

    return Array.isArray(legacyItems) ? legacyItems : items;
  }

  function readContinuationTargetId(payload) {
    const endpoints = Array.isArray(payload?.onResponseReceivedEndpoints)
      ? payload.onResponseReceivedEndpoints
      : [];

    for (const endpoint of endpoints) {
      for (const action of [
        endpoint?.appendContinuationItemsAction,
        endpoint?.reloadContinuationItemsCommand,
      ]) {
        if (action?.targetId) return action.targetId;
      }
    }

    return null;
  }

  function parseCommentsResponse(payload) {
    const comments = [];
    const entities = readCommentEntities(payload);
    let continuationToken = null;

    for (const item of collectContinuationItems(payload)) {
      if (item?.commentThreadRenderer) {
        const thread = parseCommentThread(item, entities);
        if (thread) comments.push(thread);
        continue;
      }

      const comment = parseCommentEntity(item, entities);
      if (comment) {
        comments.push(comment);
        continue;
      }

      continuationToken = findContinuationToken(item) || continuationToken;
    }

    return { comments, continuationToken, targetId: readContinuationTargetId(payload) };
  }

  function parseCommentItems(payload) {
    return parseCommentsResponse(payload).comments;
  }

  function writeVarint(value) {
    const bytes = [];
    let remaining = value;

    while (remaining > 0x7f) {
      bytes.push((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }

    bytes.push(remaining);

    return bytes;
  }

  function writeVarintField(field, value) {
    return [...writeVarint(field << 3), ...writeVarint(value)];
  }

  function writeBytesField(field, bytes) {
    return [...writeVarint((field << 3) | 2), ...writeVarint(bytes.length), ...bytes];
  }

  function writeStringField(field, value) {
    return writeBytesField(field, Array.from(new TextEncoder().encode(String(value))));
  }

  function buildRepliesContinuationToken({ videoId, commentId, channelId }) {
    if (!videoId || !commentId || !channelId) return null;

    const commentNode = [
      ...writeStringField(2, commentId),
      ...writeBytesField(4, writeVarintField(1, 0)),
      ...writeStringField(5, channelId),
      ...writeStringField(6, videoId),
      ...writeVarintField(8, 1),
      ...writeVarintField(9, 10),
      ...writeBytesField(16, writeVarintField(1, 1)),
    ];

    const bytes = [
      ...writeBytesField(2, writeStringField(2, videoId)),
      ...writeVarintField(3, 6),
      ...writeBytesField(6, [
        ...writeBytesField(3, commentNode),
        ...writeStringField(8, `comment-replies-item-${commentId}`),
      ]),
    ];

    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "%3D");
  }

  function findVideoOwnerChannelId(data, depth = 0) {
    if (!data || typeof data !== "object" || depth > 14) return null;

    const owner = data.videoOwnerRenderer;
    if (owner) {
      const channelId =
        owner.navigationEndpoint?.browseEndpoint?.browseId ||
        owner.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
        null;

      if (channelId) return channelId;
    }

    for (const value of Object.values(data)) {
      if (!value || typeof value !== "object") continue;
      const channelId = findVideoOwnerChannelId(value, depth + 1);
      if (channelId) return channelId;
    }

    return null;
  }

  function preview(value, maxLength = 180) {
    const normalized = normalizeText(value);
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 1)}...`
      : normalized;
  }

  function buildCommentRecord(parentComment, replies, zeroBasedIndex) {
    const parent = parentComment || {};
    const parentCommentId = parent.commentId || null;
    const parentAuthor = parent.author || "";
    const parentContentPreview = preview(parent.content);

    const normalizedReplies = (replies || []).map((reply, replyIndex) => ({
      ...reply,
      parentCommentId,
      parentAuthor,
      parentContentPreview,
      replyIndex: replyIndex + 1,
      isReply: true,
    }));

    return {
      index: zeroBasedIndex + 1,
      ...parent,
      isReply: false,
      repliesCount: normalizedReplies.length,
      replies: normalizedReplies,
    };
  }

  return {
    buildCommentRecord,
    buildRepliesContinuationToken,
    findCommentsContinuationToken,
    findVideoOwnerChannelId,
    normalizeText,
    parseCommentItems,
    parseCommentsResponse,
    parseCommentCountLabel,
    preview,
    readText,
  };
});
