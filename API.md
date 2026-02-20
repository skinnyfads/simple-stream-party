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
- A room is created from a selected `videoId`.
- Join and real-time sync happen over WebSocket.
- Playback state is server-authoritative.
- Any joined user can control playback (`play`, `pause`, `seek`, `changeVideo`).

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
      "streamUrl": "http://localhost:3000/videos/ZXhhbXBsZS5tcDQ/stream"
    }
  ]
}
```

## 3) Stream Video

### `GET /videos/:videoId/stream`

- Streams the selected file.
- Supports `Range` header for seek/partial loading.

Example:

```bash
curl -H "Range: bytes=0-1023" http://localhost:3000/videos/ZXhhbXBsZS5tcDQ/stream
```

Possible errors:

- `404 { "error": "video_not_found" }`
- `416 { "error": "invalid_range" }` or `416 { "error": "range_not_satisfiable" }`

## 4) Create Room From Video

### `POST /rooms/from-video`

Body:

```json
{
  "creatorId": "alice",
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
  "revision": 1,
  "playback": {
    "videoId": "ZXhhbXBsZS5tcDQ",
    "videoUrl": "/videos/ZXhhbXBsZS5tcDQ/stream",
    "playbackTimeSec": 0,
    "isPlaying": false,
    "lastUpdatedAtMs": 1739720000000
  }
}
```

Possible errors:

- `404 { "error": "video_not_found" }`

## 5) Room WebSocket

### `GET /rooms/:roomId/ws?userId=...&inviteToken=...`

Open a WebSocket connection to join the room and receive real-time updates.

Example:

```js
const ws = new WebSocket(
  `ws://localhost:3000/rooms/${roomId}/ws?userId=${encodeURIComponent(userId)}&inviteToken=${encodeURIComponent(token)}`,
);
```

Connection errors are sent as WebSocket messages then the socket is closed:

```json
{ "type": "error", "error": "room_not_found" }
```

Possible connection errors:

- `room_not_found`
- `missing_user_id`
- `invalid_invite_token`

## 6) Leave Room

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
    "revision": 9,
    "playback": {
      "videoId": "ZXhhbXBsZS5tcDQ",
      "videoUrl": "/videos/ZXhhbXBsZS5tcDQ/stream",
      "playbackTimeSec": 44.2,
      "isPlaying": false,
      "lastUpdatedAtMs": 1739720044200
    }
  }
}
```

Possible errors:

- `400 { "error": "missing_user_id" }`
- `403 { "error": "invalid_invite_token" }`
- `404 { "error": "room_not_found" }`

## 7) Client -> Server Messages

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

Validation errors are returned as:

```json
{ "type": "error", "error": "invalid_seek_time" }
```

Possible playback errors:

- `invalid_seek_time`
- `missing_video_id`
- `video_not_found`

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

## 8) Server -> Client Messages

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
    "revision": 5,
    "playback": {
      "videoId": "ZXhhbXBsZS5tcDQ",
      "videoUrl": "/videos/ZXhhbXBsZS5tcDQ/stream",
      "playbackTimeSec": 42.3,
      "isPlaying": true,
      "lastUpdatedAtMs": 1739720042300
    }
  },
  "messages": []
}
```

### Room state update

```json
{
  "type": "room_state",
  "reason": "playback",
  "byUserId": "bob",
  "action": "seek",
  "room": {
    "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
    "revision": 6,
    "creatorId": "alice",
    "inviteToken": "a3ecac17-f084-428b-a6bc-778899001122",
    "shareUrl": "http://localhost:3000/room/c2d6b6c2-3f1f-49f1-9f8f-112233445566?token=a3ecac17-f084-428b-a6bc-778899001122",
    "memberCount": 2,
    "playback": {
      "videoId": "ZXhhbXBsZS5tcDQ",
      "videoUrl": "/videos/ZXhhbXBsZS5tcDQ/stream",
      "playbackTimeSec": 44.2,
      "isPlaying": false,
      "lastUpdatedAtMs": 1739720044200
    }
  }
}
```

`reason` values:

- `join`
- `leave`
- `playback`
- `video_change`
- `sync`

### Chat event

```json
{
  "type": "chat_message",
  "revision": 8,
  "message": {
    "id": "e15f7ab7-a54a-4f24-a7b8-001122334455",
    "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
    "userId": "bob",
    "message": "hello everyone",
    "createdAtMs": 1739720050000,
    "replyToMessageId": "5f4f4c8d-8e9d-4e7e-8a1d-889900112233"
  }
}
```

`replyToMessageId` is optional and only present when the message is a reply.

### Pong

```json
{ "type": "pong", "at": "2026-02-16T20:00:00.000Z" }
```

## Frontend Integration Flow

1. Call `GET /videos` and render a selectable list.
2. Call `POST /rooms/from-video` when a video is selected.
3. Copy/share `shareUrl` (contains room id + token).
4. Connect WebSocket to `/rooms/:roomId/ws?userId=...&inviteToken=...`.
5. On `welcome`, load `room.playback.videoUrl` and initial message list.
6. Send `playback` messages when the user interacts with player controls.
7. Apply updates from `room_state` events.
8. Send/receive chat through `chat` and `chat_message` events.
9. When a user leaves intentionally, call `POST /rooms/:roomId/leave`.

## Notes

- Storage is in-memory for rooms/chat; data resets on restart.
- Sync transport uses WebSocket.
