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
    parseCommentCountLabel,
    preview,
  };
});
