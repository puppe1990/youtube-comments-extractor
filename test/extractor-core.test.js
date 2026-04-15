const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCommentRecord } = require("../src/extractor-core");

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
