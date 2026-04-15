(function attachCore(root, factory) {
  const core = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = core;
  }

  if (root) {
    root.YouTubeCommentsExtractorCore = core;
  }
})(typeof globalThis !== "undefined" ? globalThis : null, function createCore() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
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
    normalizeText,
    preview,
  };
});
