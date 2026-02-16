# Simple Stream Party API

This document explains how to use the current backend API.

## Base URL

- Local: `http://localhost:3000`
- Configurable with env:
  - `HOST` (default: `0.0.0.0`)
  - `PORT` (default: `3000`)
  - `DATA_DIR` (default: `data`)
  - `PUBLIC_BASE_URL` (optional, used for generated `shareUrl`)

## Core Concepts

- Videos are read from `./data` (or `DATA_DIR`).
- A room is created from a selected `videoId`.
- Join requires `inviteToken`.
- Playback state is server-authoritative.
- Any user that has joined a room can control playback (`play`, `pause`, `seek`, `changeVideo`).

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

## 5) Join Room

### `POST /rooms/:roomId/join`

Body:

```json
{
  "userId": "bob",
  "inviteToken": "a3ecac17-f084-428b-a6bc-778899001122"
}
```

Response:

```json
{
  "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
  "creatorId": "alice",
  "inviteToken": "a3ecac17-f084-428b-a6bc-778899001122",
  "shareUrl": "http://localhost:3000/room/c2d6b6c2-3f1f-49f1-9f8f-112233445566?token=a3ecac17-f084-428b-a6bc-778899001122",
  "memberCount": 2,
  "revision": 2,
  "playback": {
    "videoId": "ZXhhbXBsZS5tcDQ",
    "videoUrl": "/videos/ZXhhbXBsZS5tcDQ/stream",
    "playbackTimeSec": 0.8,
    "isPlaying": true,
    "lastUpdatedAtMs": 1739720000800
  }
}
```

Possible errors:

- `404 { "error": "room_not_found" }`
- `403 { "error": "invalid_invite_token" }`

## 6) Get Room State (Sync)

### `GET /rooms/:roomId/state`

Use this to sync the player state. Server returns normalized playback time.

Response:

```json
{
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
}
```

Possible errors:

- `404 { "error": "room_not_found" }`

## 7) Playback Control

### `POST /rooms/:roomId/playback`

All joined users can control playback.

Body:

```json
{
  "userId": "bob",
  "action": "pause"
}
```

Supported actions:

- `play`
- `pause`
- `seek` (requires `atTimeSec`)
- `changeVideo` (requires `videoId`)

Examples:

```json
{ "userId": "bob", "action": "seek", "atTimeSec": 123.45 }
```

```json
{ "userId": "bob", "action": "changeVideo", "videoId": "YW5vdGhlci5tcDQ" }
```

Response:

```json
{
  "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
  "revision": 6,
  "action": "pause",
  "byUserId": "bob",
  "playback": {
    "videoId": "ZXhhbXBsZS5tcDQ",
    "videoUrl": "/videos/ZXhhbXBsZS5tcDQ/stream",
    "playbackTimeSec": 44.2,
    "isPlaying": false,
    "lastUpdatedAtMs": 1739720044200
  }
}
```

Possible errors:

- `404 { "error": "room_not_found" }`
- `403 { "error": "user_not_in_room" }`
- `400 { "error": "invalid_seek_time" }`
- `400 { "error": "missing_video_id" }`
- `404 { "error": "video_not_found" }`

## 8) Chat

### `POST /rooms/:roomId/chat`

Body:

```json
{
  "userId": "bob",
  "message": "hello everyone"
}
```

Response (`201`):

```json
{
  "id": "e15f7ab7-a54a-4f24-a7b8-001122334455",
  "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
  "userId": "bob",
  "message": "hello everyone",
  "createdAtMs": 1739720050000
}
```

Possible errors:

- `404 { "error": "room_not_found" }`
- `403 { "error": "user_not_in_room" }`
- `400 { "error": "message_empty" }`

### `GET /rooms/:roomId/chat`

Response:

```json
{
  "roomId": "c2d6b6c2-3f1f-49f1-9f8f-112233445566",
  "revision": 8,
  "messages": []
}
```

## Frontend Integration Flow

1. Call `GET /videos` and render selectable list.
2. On click, call `POST /rooms/from-video`.
3. Copy/share `shareUrl`.
4. Invitee opens link, parse `roomId` + `token`, then call `POST /rooms/:roomId/join`.
5. Player loads `playback.videoUrl`.
6. Send playback actions with `POST /rooms/:roomId/playback`.
7. Poll `GET /rooms/:roomId/state` (or move to WebSocket later) to stay synced.
8. Use chat endpoints for room chat.

## Notes

- Current storage is in-memory for rooms/chat; data resets on restart.
- Current sync transport is HTTP polling (no WebSocket push yet).
