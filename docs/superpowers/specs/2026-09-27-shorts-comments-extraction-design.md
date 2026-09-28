# Shorts comments extraction

**Date:** 2026-09-27  
**Status:** approved design

## Problem

The extension extracts comments from YouTube watch pages (`/watch?v=ID`). Shorts live at `/shorts/ID`. Opening a Short and clicking extract fails before any collection starts: the content script is not injected, and the popup rejects the URL.

Evidence from a live Short (`https://www.youtube.com/shorts/CnTnVrfO348`):

- Comments action: `Ver 2.576 comentários`
- Open panel: `Classificar comentários`, heading `Comentários 2,5 mil`, `ytd-engagement-panel-section-list-renderer`
- Comment list still uses `/youtubei/v1/next` (`GetWatchWebTopLevelComments`)
- Shorts feed navigation uses `reel/reel_item_watch` and `reel/reel_watch_sequence`

## Goal

Extract every comment thread and reply of the Short currently in the URL, using the existing API-first pipeline and DOM fallback. One Short per run. The Shorts feed is out of scope.

## Non-goals

- Extracting comments from other Shorts while the user scrolls the feed
- A new Innertube endpoint (`reel_item_watch`) for comment pages
- Redirecting the tab to `/watch?v=ID`
- Changing the JSON shape of each comment/reply record

## Architecture

Treat `/shorts/VIDEO_ID` as a valid video page, same as `/watch`.

The popup still only validates the tab and sends `YT_COMMENTS_EXTRACT`. The content script owns collection. `extractor-core` keeps parsing `/youtubei/v1/next` payloads.

```
popup (accept /watch and /shorts)
  -> content script (pin videoId, open comments panel if needed)
    -> extractor-core (continuation token + parse next/replies)
    -> fetch https://www.youtube.com/youtubei/v1/next
```

## Components

### `manifest.json`

Add content-script matches:

- `https://www.youtube.com/shorts*`
- `https://m.youtube.com/shorts*`

Keep the existing `/watch*` matches.

### `popup.js`

Treat these as video pages:

- `https://www.youtube.com/watch...`
- `https://m.youtube.com/watch...`
- `https://www.youtube.com/shorts/...`
- `https://m.youtube.com/shorts/...`

Use the same check in restore, extract, and reset. The error for a non-video tab stays: `Abra uma pagina de video do YouTube antes de extrair.`

### `content.js`

- Parse `videoId` from `/shorts/ID` and from `?v=`
- At the start of a run, pin that `videoId`. API requests use the pinned id even if the feed advances
- Export `url` as `https://www.youtube.com/shorts/ID` on Shorts pages, and `https://www.youtube.com/watch?v=ID` on watch pages
- Read the title from the Short `h1` (fallback: `document.title`)
- Open comments by clicking the action whose label is “view N comments” (`Ver 2.576 comentários` / English equivalent). Do not click `Classificar comentários`
- Read expected count from `ytd-comments-header-renderer` when present, otherwise from the comments heading (`Comentários 2,5 mil`) or the more precise comments button (`Ver 2.576 comentários`)
- DOM fallback: open the same engagement panel, scroll it, expand replies, collect threads with the existing selectors

### `src/extractor-core.js`

`findCommentsContinuationToken` must also accept Shorts panel hosts:

- `targetId === "engagement-panel-comments-section"`
- `targetId === "comments-section"` (already supported)
- `sectionIdentifier === "comment-item-section"` (already supported)
- `commentsHeaderRenderer` (already supported)

`parseCommentsResponse` and reply-token construction stay unchanged. Comments still come from `/youtubei/v1/next`.

## Data flow

### API mode (primary)

1. Popup confirms a watch or Shorts URL and asks the content script to extract.
2. Content script pins `videoId` from the current URL.
3. Read continuation from `ytInitialData`, `ytd-comments` data, and the comments engagement panel.
4. If there is no token, click the comments action, wait for the panel, and read again.
5. Page `/youtubei/v1/next` with that token. Load each thread’s replies the same way as watch (server token, then built token).
6. Build the existing result object, with Shorts `url` / `videoId` / title filled in.

### DOM mode (fallback)

1. Open the comments panel if it is collapsed.
2. Scroll the panel until thread count stabilizes or matches expected count.
3. Expand replies.
4. Collect visible threads.

If the user switches Short during a DOM run, compare the current URL’s `videoId` to the pinned id. If they differ, stop with an error asking to keep the original Short open.

## Result JSON

Same top-level fields as today: `title`, `url`, `videoId`, `mode`, `totalThreads`, `totalReplies`, `visibleCommentCount`, `expectedCommentCount`, `truncated`, `data`.

On a Short:

```json
{
  "title": "Harvard Mindset to Never Waste Another Second Again",
  "url": "https://www.youtube.com/shorts/CnTnVrfO348",
  "videoId": "CnTnVrfO348",
  "mode": "api"
}
```

Comment and reply records keep the current fields (`commentId`, `author`, `content`, `parentCommentId`, …).

## Error handling

| Situation | Behavior |
| --- | --- |
| Tab is not watch or Shorts | Popup error: open a YouTube video page |
| API has no token or YouTube rejects the request | Fall back to DOM, same as watch |
| API and DOM both find zero threads | Existing zero-comment error, including whether the Shorts panel opened |
| Comments disabled / count is zero | Zero-thread error; `expectedCommentCount` is `0` when YouTube shows that |
| Feed advances during API run | Keep using the pinned `videoId` |
| Feed advances during DOM run (`location` videoId ≠ pinned id) | Stop and ask the user to keep the original Short open |
| Popup closed during API paging | Continue, same as watch |
| Page/thread cap reached | `truncated: true` |
| A replies continuation is used as a comments page token | Existing invalid-pagination error |

## Testing

Keep every current `/watch` test passing.

Add coverage for:

- `getVideoIdFromUrl` and video meta on `/shorts/ID` (canonical Shorts URL, `h1` title)
- Popup accepts `/shorts/` and rejects a non-video URL
- Continuation token from `engagement-panel-comments-section` and from Shorts `ytInitialData`
- Comments action `Ver 2.576 comentários` opens the panel; `Classificar comentários` does not
- Expected count from the button (`2.576`) and from the heading (`2,5 mil`)
- API and DOM extraction with a Shorts `location.href`
- Pinned `videoId` when the URL changes to another Short mid-run

## Implementation notes

- Prefer the more precise expected count when both a rounded heading (`2,5 mil`) and an exact button (`2.576`) exist.
- `readPageApiContextInPage` in the popup must include the Shorts comments panel among token sources.
- Do not add `reel_item_watch` as a comments pager.
