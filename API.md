# Simple Stream Party API

This document explains how to use the backend API.

## Base URL

- HTTP: `http://localhost:3000`
- WS: `ws://localhost:3000`
- Configurable with env:
  - `HOST` (default: `0.0.0.0`)
  - `PORT` (default: `3000`)
  - `DATA_DIR` (default: `data`)
  - `PUBLIC_BASE_URL` (optional, used for generated `shareUrl`)

## Core Concepts

- Videos are read from `./data` (or `DATA_DIR`).
- Local subtitle files are read from `./data/subtitles` (`.vtt`, `.srt`).
- A room is created from a selected `videoId`.
- Join and real-time sync happen over WebSocket.
- Playback state is server-authoritative.
- Any joined user can control playback (`play`, `pause`, `seek`, `changeVideo`, `changeSubtitle`).

## 1) Health Check

### `GET /health`

Response:

```json
{
  "ok": true,
  "service": "simple-stream-party",
  "at": "2026-02-16T20:00:00.000Z"
}
```

## 2) List Videos

### `GET /videos`

Returns all supported files in `DATA_DIR` (`.mp4`, `.webm`, `.mkv`, `.mov`, `.m4v`).

Response:

```json
{
  "dataDir": "/absolute/path/to/data",
  "count": 2,
  "videos": [
    {
      "id": "ZXhhbXBsZS5tcDQ",
      "fileName": "example.mp4",
      "sizeBytes": 12582912,
      "modifiedAtMs": 1739720000000,
      "hlsUrl": "http://localhost:3000/videos/ZXhhbXBsZS5tcDQ/hls/playlist.m3u8",
      "hlsStatus": "ready"
    }
  ]
}
```

## 3) HLS Streaming

### `GET /videos/:videoId/hls/status`

- Returns the current transcoding status of the video (`pending`, `processing`, `ready`, `error`).

Example Response:

```json
{
  "videoId": "ZXhhbXBsZS5tcDQ",
  "status": "ready"
}
```

### `GET /videos/:videoId/hls/*`

- Serves the `.m3u8` playlist and `.ts` video segments for HLS playback.
- Segment files are cached aggressively; playlist files are not cached.

Possible errors:

- `404 { "error": "hls_not_ready" }` if transcoding is not yet complete.
- `404 { "error": "file_not_found" }`
- `400 { "error": "invalid_hls_file_type" }`

## 4) Subtitles (Soft-subs)

### `GET /subtitles`

Returns subtitle files from `DATA_DIR/subtitles` (`.vtt`, `.srt`).

Response:

```json
{
  "dataDir": "/absolute/path/to/data/subtitles",
  "count": 1,
  "subtitles": [
    {
      "id": "MTc0MzM0MDEwMDAwMC1hYmNkLXN1YnMudnR0",
      "fileName": "1743340100000-abcd-subs.vtt",
      "sizeBytes": 2048,
      "modifiedAtMs": 1739720000000,
      "format": "vtt",
      "trackUrl": "http://localhost:3000/subtitles/MTc0MzM0MDEwMDAwMC1hYmNkLXN1YnMudnR0/track"
    }
  ]
}
```

### `GET /subtitles/:subtitleId/track`

- Returns a `text/vtt` subtitle track (soft-sub).
- If source file is `.srt`, server converts it to WebVTT on the fly.

Possible errors:

- `404 { "error": "subtitle_not_found" }`

### `POST /subtitles/upload`

Upload subtitle content (base64) from a local file picker in clients.

Body:

```json
{
  "fileName": "my-subtitles.srt",
  "contentBase64": "MQowMDowMDowMCwwMDAgLS0+IDAwOjAwOjAyLDAwMApIZWxsbwo="
}
```

Response (`201`):

```json
{
  "subtitle": {
    "id": "MTc0MzM0MDEwMDAwMC1hYmNkLW15LXN1YnRpdGxlcy5zcnQ",
    "fileName": "1743340100000-abcd-my-subtitles.srt",
    "sizeBytes": 56,
    "modifiedAtMs": 1739720000000,
    "format": "srt",
    "trackUrl": "http://localhost:3000/subtitles/MTc0MzM0MDEwMDAwMC1hYmNkLW15LXN1YnRpdGxlcy5zcnQ/track"
  }
}
```

Possible errors:

- `400 { "error": "invalid_subtitle_file_name" }`
- `400 { "error": "unsupported_subtitle_format" }`
- `400 { "error": "missing_subtitle_content" }`
- `400 { "error": "invalid_subtitle_content" }`
- `413 { "error": "subtitle_too_large" }`

## 5) Create Room From Video

### `POST /rooms/from-video`

Body:

```json
{
  "creatorId": "alice",
  "creatorNickname": "Alice",
  "videoId": "ZXhhbXBsZS5tcDQ"
}
```

Response (`201`):

```json
{
  "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
  "creatorId": "alice",
  "inviteToken": "a3ecac17-f084-428b-a6bc-778899001122",
  "shareUrl": "http://localhost:3000/room/c2d6b6c2-3f1f-49f1-9f8f-112233445566?token=a3ecac17-f084-428b-a6bc-778899001122",
  "memberCount": 1,
  "members": [{ "userId": "alice", "nickname": "Alice" }],
  "revision": 1,
  "playback": {
    "videoId": "ZXhhbXBsZS5tcDQ",
    "videoUrl": "/videos/ZXhhbXBsZS5tcDQ/stream",
    "hlsUrl": "/videos/ZXhhbXBsZS5tcDQ/hls/playlist.m3u8",
    "playbackTimeSec": 0,
    "isPlaying": false,
    "lastUpdatedAtMs": 1739720000000,
    "subtitle": null
  }
}
```

Possible errors:

- `404 { "error": "video_not_found" }`

## 6) Room WebSocket

### `GET /rooms/:roomId/ws?userId=...&inviteToken=...&nickname=...`

Open a WebSocket connection to join the room and receive real-time updates.

Example:

```js
const ws = new WebSocket(
  `ws://localhost:3000/rooms/${roomId}/ws?userId=${encodeURIComponent(userId)}&inviteToken=${encodeURIComponent(token)}&nickname=${encodeURIComponent("Alice")}`,
);
```

`nickname` is optional (max 32 chars). If omitted, it defaults to `userId`.

Connection errors are sent as WebSocket messages then the socket is closed:

```json
{ "type": "error", "error": "room_not_found" }
```

Possible connection errors:

- `room_not_found`
- `missing_user_id`
- `invalid_invite_token`
- `invalid_nickname`

## 7) Leave Room

### `POST /rooms/:roomId/leave`

Removes a user from `room.members`, broadcasts a `room_state` update with `reason: "leave"`, and closes that user's active sockets in the room.

Body:

```json
{
  "userId": "bob",
  "inviteToken": "a3ecac17-f084-428b-a6bc-778899001122"
}
```

Response (`200`):

```json
{
  "left": true,
  "room": {
    "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
    "creatorId": "alice",
    "inviteToken": "a3ecac17-f084-428b-a6bc-778899001122",
    "shareUrl": "http://localhost:3000/room/c2d6b6c2-3f1f-49f1-9f8f-112233445566?token=a3ecac17-f084-428b-a6bc-778899001122",
    "memberCount": 1,
    "members": [{ "userId": "alice", "nickname": "Alice" }],
    "revision": 9,
    "playback": {
      "videoId": "ZXhhbXBsZS5tcDQ",
      "videoUrl": "/videos/ZXhhbXBsZS5tcDQ/stream",
      "hlsUrl": "/videos/ZXhhbXBsZS5tcDQ/hls/playlist.m3u8",
      "playbackTimeSec": 44.2,
      "isPlaying": false,
      "lastUpdatedAtMs": 1739720044200,
      "subtitle": null
    }
  }
}
```

Possible errors:

- `400 { "error": "missing_user_id" }`
- `403 { "error": "invalid_invite_token" }`
- `404 { "error": "room_not_found" }`

## 8) Client -> Server Messages

### Playback action

```json
{ "type": "playback", "action": "play" }
```

```json
{ "type": "playback", "action": "pause" }
```

```json
{ "type": "playback", "action": "seek", "atTimeSec": 123.45 }
```

```json
{ "type": "playback", "action": "changeVideo", "videoId": "YW5vdGhlci5tcDQ" }
```

Set subtitle from local server-stored subtitle id:

```json
{
  "type": "playback",
  "action": "changeSubtitle",
  "subtitleId": "MTc0MzM0MDEwMDAwMC1hYmNkLW15LXN1YnRpdGxlcy5zcnQ",
  "subtitleLabel": "English",
  "subtitleLanguage": "en"
}
```

Set subtitle from external link:

```json
{
  "type": "playback",
  "action": "changeSubtitle",
  "subtitleUrl": "https://example.com/subs/movie.vtt",
  "subtitleLabel": "English CC",
  "subtitleLanguage": "en"
}
```

Clear subtitle:

```json
{ "type": "playback", "action": "changeSubtitle" }
```

Validation errors are returned as:

```json
{ "type": "error", "error": "invalid_seek_time" }
```

Possible playback errors:

- `invalid_seek_time`
- `missing_video_id`
- `video_not_found`
- `subtitle_not_found`
- `invalid_subtitle_url`
- `ambiguous_subtitle_source`

### Update nickname

```json
{ "type": "profile", "action": "setNickname", "nickname": "Alice Cooper" }
```

Possible profile errors:

- `invalid_profile_action`
- `invalid_nickname`

### Chat message

```json
{ "type": "chat", "message": "hello everyone" }
```

Reply to a previous chat message by id:

```json
{
  "type": "chat",
  "message": "I agree",
  "replyToMessageId": "e15f7ab7-a54a-4f24-a7b8-001122334455"
}
```

Possible error:

- `message_empty`
- `invalid_reply_message_id`
- `reply_message_not_found`

### Manual sync request

```json
{ "type": "sync" }
```

### Ping

```json
{ "type": "ping" }
```

## 9) Server -> Client Messages

### Welcome (sent once on connect)

```json
{
  "type": "welcome",
  "room": {
    "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
    "creatorId": "alice",
    "inviteToken": "a3ecac17-f084-428b-a6bc-778899001122",
    "shareUrl": "http://localhost:3000/room/c2d6b6c2-3f1f-49f1-9f8f-112233445566?token=a3ecac17-f084-428b-a6bc-778899001122",
    "memberCount": 2,
    "members": [
      { "userId": "alice", "nickname": "Alice" },
      { "userId": "bob", "nickname": "Bobby" }
    ],
    "revision": 5,
    "playback": {
      "videoId": "ZXhhbXBsZS5tcDQ",
      "videoUrl": "/videos/ZXhhbXBsZS5tcDQ/stream",
      "hlsUrl": "/videos/ZXhhbXBsZS5tcDQ/hls/playlist.m3u8",
      "playbackTimeSec": 42.3,
      "isPlaying": true,
      "lastUpdatedAtMs": 1739720042300,
      "subtitle": {
        "source": "local",
        "trackUrl": "/subtitles/MTc0MzM0MDEwMDAwMC1hYmNkLW15LXN1YnRpdGxlcy5zcnQ/track",
        "label": "English",
        "language": "en"
      }
    }
  },
  "messages": [],
  "playbackActivities": [
    {
      "id": "8b55dcfe-6df3-4d1c-8ff6-001122334455",
      "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
      "userId": "bob",
      "userDisplayName": "Bobby",
      "action": "seek",
      "playbackTimeSec": 44.2,
      "isPlaying": false,
      "videoId": "ZXhhbXBsZS5tcDQ",
      "createdAtMs": 1739720044200,
      "revision": 6
    }
  ]
}
```

`playbackActivities` contains recent playback timeline entries for the room
(up to 200), so clients can rebuild activity UI after reconnect/refresh.

### Room state update

```json
{
  "type": "room_state",
  "reason": "playback",
  "byUserId": "bob",
  "byDisplayName": "Bobby",
  "action": "seek",
  "room": {
    "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
    "revision": 6,
    "creatorId": "alice",
    "inviteToken": "a3ecac17-f084-428b-a6bc-778899001122",
    "shareUrl": "http://localhost:3000/room/c2d6b6c2-3f1f-49f1-9f8f-112233445566?token=a3ecac17-f084-428b-a6bc-778899001122",
    "memberCount": 2,
    "members": [
      { "userId": "alice", "nickname": "Alice" },
      { "userId": "bob", "nickname": "Bobby" }
    ],
    "playback": {
      "videoId": "ZXhhbXBsZS5tcDQ",
      "videoUrl": "/videos/ZXhhbXBsZS5tcDQ/stream",
      "hlsUrl": "/videos/ZXhhbXBsZS5tcDQ/hls/playlist.m3u8",
      "playbackTimeSec": 44.2,
      "isPlaying": false,
      "lastUpdatedAtMs": 1739720044200,
      "subtitle": null
    }
  }
}
```

`byDisplayName` is optional.

`reason` values:

- `join`
- `leave`
- `playback`
- `video_change`
- `subtitle_change`
- `sync`
- `nickname_change`

### Chat event

```json
{
  "type": "chat_message",
  "revision": 8,
  "message": {
    "id": "e15f7ab7-a54a-4f24-a7b8-001122334455",
    "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
    "userId": "bob",
    "userDisplayName": "Bobby",
    "message": "hello everyone",
    "createdAtMs": 1739720050000,
    "replyToMessageId": "5f4f4c8d-8e9d-4e7e-8a1d-889900112233"
  }
}
```

`replyToMessageId` is optional and only present when the message is a reply.
`userDisplayName` is optional.
Playback actions (`play`, `pause`, `seek`, `changeVideo`) are not emitted as chat messages; they are delivered via `room_state` updates.

### Pong

```json
{ "type": "pong", "at": "2026-02-16T20:00:00.000Z" }
```

## Frontend Integration Flow

1. Call `GET /videos` and render a selectable list.
2. Call `POST /rooms/from-video` when a video is selected.
3. Copy/share `shareUrl` (contains room id + token).
4. Connect WebSocket to `/rooms/:roomId/ws?userId=...&inviteToken=...&nickname=...`.
5. On `welcome`, load `room.playback.hlsUrl` (or poll `status` if processing) and initial message list.
6. Send `playback` messages when the user interacts with player controls.
7. Apply updates from `room_state` events.
8. Send/receive chat through `chat` and `chat_message` events.
9. Send `profile:setNickname` when user updates display name.
10. When a user leaves intentionally, call `POST /rooms/:roomId/leave`.

## Notes

- Storage is in-memory for rooms/chat; data resets on restart.
- Sync transport uses WebSocket.
