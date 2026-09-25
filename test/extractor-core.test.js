const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCommentRecord, parseCommentCountLabel } = require("../src/extractor-core");

test("parseCommentCountLabel reads localized comment counters", () => {
  assert.equal(parseCommentCountLabel("68"), 68);
  assert.equal(parseCommentCountLabel("68 comentarios"), 68);
  assert.equal(parseCommentCountLabel("Comentarios 68"), 68);
  assert.equal(parseCommentCountLabel("1.234"), 1234);
  assert.equal(parseCommentCountLabel("1,2 mil"), 1200);
  assert.equal(parseCommentCountLabel("12 mil comentarios"), 12000);
  assert.equal(parseCommentCountLabel("2,5 mi"), 2500000);
  assert.equal(parseCommentCountLabel("1.2K comments"), 1200);
});

test("parseCommentCountLabel returns null when there is no number", () => {
  assert.equal(parseCommentCountLabel(""), null);
  assert.equal(parseCommentCountLabel(null), null);
  assert.equal(parseCommentCountLabel("Comentarios"), null);
  assert.equal(parseCommentCountLabel("Classificar comentarios"), null);
});

test("buildCommentRecord marks each reply with its parent comment", () => {
  const parent = {
    commentId: "parent-123",
    author: "Canal Pai",
    content: "Comentario principal completo para validar preview do pai.",
    published: "ha 2 dias",
    likes: "10",
  };

  const replies = [
    {
      commentId: "reply-1",
      author: "Resposta Um",
      content: "Primeira resposta",
      published: "ha 1 dia",
      likes: "2",
    },
    {
      commentId: "reply-2",
      author: "Resposta Dois",
      content: "Segunda resposta",
      published: "ha 3 horas",
      likes: "0",
    },
  ];

  const record = buildCommentRecord(parent, replies, 0);

  assert.equal(record.index, 1);
  assert.equal(record.commentId, "parent-123");
  assert.equal(record.repliesCount, 2);
  assert.deepEqual(
    record.replies.map((reply) => ({
      commentId: reply.commentId,
      parentCommentId: reply.parentCommentId,
      parentAuthor: reply.parentAuthor,
      parentContentPreview: reply.parentContentPreview,
      replyIndex: reply.replyIndex,
    })),
    [
      {
        commentId: "reply-1",
        parentCommentId: "parent-123",
        parentAuthor: "Canal Pai",
        parentContentPreview: "Comentario principal completo para validar preview do pai.",
        replyIndex: 1,
      },
      {
        commentId: "reply-2",
        parentCommentId: "parent-123",
        parentAuthor: "Canal Pai",
        parentContentPreview: "Comentario principal completo para validar preview do pai.",
        replyIndex: 2,
      },
    ]
  );
});
