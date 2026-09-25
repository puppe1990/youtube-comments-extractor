const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCommentRecord,
  findCommentsContinuationToken,
  parseCommentItems,
  parseCommentsResponse,
  parseCommentCountLabel,
} = require("../src/extractor-core");

function createNextPage(items) {
  return {
    onResponseReceivedEndpoints: [
      { appendContinuationItemsAction: { continuationItems: items } },
    ],
  };
}

function createContinuationItem(token) {
  return {
    continuationItemRenderer: {
      continuationEndpoint: { continuationCommand: { token } },
    },
  };
}

const legacyThreadItem = {
  commentThreadRenderer: {
    comment: {
      commentRenderer: {
        commentId: "UgxLegacyTop",
        authorText: { simpleText: "Maria Silva" },
        authorEndpoint: { browseEndpoint: { canonicalBaseUrl: "/@maria" } },
        contentText: { runs: [{ text: "Comentario " }, { text: "legado" }] },
        publishedTimeText: { runs: [{ text: "ha 2 dias" }] },
        voteCount: { simpleText: "12" },
        replies: {
          commentRepliesRenderer: {
            contents: [
              {
                commentRenderer: {
                  commentId: "UgxLegacyReply",
                  authorText: { simpleText: "Joao" },
                  contentText: { simpleText: "Resposta legada" },
                },
              },
              createContinuationItem("REPLY_TOKEN"),
            ],
          },
        },
      },
    },
  },
};

test("parseCommentsResponse reads the legacy comment renderer payload", () => {
  const page = createNextPage([legacyThreadItem, createContinuationItem("NEXT_PAGE_TOKEN")]);
  const parsed = parseCommentsResponse(page);

  assert.equal(parsed.continuationToken, "NEXT_PAGE_TOKEN");
  assert.equal(parsed.comments.length, 1);
  assert.equal(parsed.comments[0].commentId, "UgxLegacyTop");
  assert.equal(parsed.comments[0].author, "Maria Silva");
  assert.equal(parsed.comments[0].authorChannelUrl, "/@maria");
  assert.equal(parsed.comments[0].content, "Comentario legado");
  assert.equal(parsed.comments[0].published, "ha 2 dias");
  assert.equal(parsed.comments[0].likes, "12");
  assert.equal(parsed.comments[0].repliesContinuationToken, "REPLY_TOKEN");
  assert.deepEqual(
    parsed.comments[0].replies.map((reply) => reply.commentId),
    ["UgxLegacyReply"]
  );
  assert.equal(parsed.comments[0].replies[0].content, "Resposta legada");
});

test("parseCommentsResponse reads the commentViewModel payload", () => {
  const page = createNextPage([
    {
      commentThreadRenderer: {
        commentViewModel: {
          commentViewModel: {
            commentId: "UgxNewTop",
            authorName: { content: "@canal-novo" },
            content: { content: "Comentario novo" },
            publishedTimeText: { content: "ha 1 hora" },
            likeCount: "3",
          },
        },
      },
    },
    createContinuationItem("NEXT_2"),
  ]);
  const parsed = parseCommentsResponse(page);

  assert.equal(parsed.continuationToken, "NEXT_2");
  assert.equal(parsed.comments.length, 1);
  assert.deepEqual(parsed.comments[0], {
    commentId: "UgxNewTop",
    author: "@canal-novo",
    authorChannelUrl: null,
    content: "Comentario novo",
    published: "ha 1 hora",
    likes: "3",
    replies: [],
    repliesContinuationToken: null,
  });
});

test("parseCommentItems handles reply pages and the legacy continuation shape", () => {
  const replyPage = createNextPage([
    {
      commentRenderer: {
        commentId: "UgxReplyPage",
        contentText: { simpleText: "Resposta paginada" },
      },
    },
    createContinuationItem("MORE_REPLIES"),
  ]);

  assert.deepEqual(
    parseCommentItems(replyPage).map((comment) => comment.commentId),
    ["UgxReplyPage"]
  );

  const legacyPage = {
    continuationContents: {
      commentSectionContinuation: {
        contents: [{ commentRenderer: { commentId: "UgxLegacySection", contentText: { simpleText: "Antigo" } } }],
      },
    },
  };

  assert.deepEqual(
    parseCommentItems(legacyPage).map((comment) => comment.commentId),
    ["UgxLegacySection"]
  );
});

test("findCommentsContinuationToken reads the token from the watch page data", () => {
  const data = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              { itemSectionRenderer: { sectionIdentifier: "comment-item-section", contents: [{ commentsHeaderRenderer: { countText: { simpleText: "68" } } }, createContinuationItem("COMMENTS_TOKEN")] } },
            ],
          },
        },
      },
    },
  };

  assert.equal(findCommentsContinuationToken(data), "COMMENTS_TOKEN");
});

test("findCommentsContinuationToken falls back to the comments header renderer", () => {
  const data = {
    contents: [
      {
        commentsSectionRenderer: {
          contents: [
            { commentsHeaderRenderer: { countText: { simpleText: "12" } } },
            createContinuationItem("HEADER_TOKEN"),
          ],
        },
      },
    ],
  };

  assert.equal(findCommentsContinuationToken(data), "HEADER_TOKEN");
});

test("findCommentsContinuationToken ignores unrelated sections", () => {
  const data = {
    contents: {
      twoColumnWatchNextResults: {
        secondaryResults: { results: [createContinuationItem("SIDEBAR_TOKEN")] },
      },
    },
  };

  assert.equal(findCommentsContinuationToken(data), null);
  assert.equal(findCommentsContinuationToken(null), null);
});

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
