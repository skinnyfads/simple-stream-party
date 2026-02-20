import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import env from "./env.js";
import {
  dedupePlaybackBurst,
  type DedupablePlaybackAction,
  type PlaybackBurstEvent,
} from "./playback-dedupe.js";
import type { RawData, WebSocket } from "ws";

type PlaybackAction = "play" | "pause" | "seek" | "changeVideo";

type PlaybackState = {
  videoId: string;
  videoUrl: string;
  playbackTimeSec: number;
  isPlaying: boolean;
  lastUpdatedAtMs: number;
};

type Room = {
  id: string;
  creatorId: string;
  inviteToken: string;
  members: Set<string>;
  memberProfiles: Map<string, MemberProfile>;
  playback: PlaybackState;
  createdAtMs: number;
  revision: number;
  activeControllerId: string | null;
  activeControllerUntilMs: number;
};

type MemberProfile = {
  userId: string;
  nickname: string;
};

type ChatMessage = {
  id: string;
  roomId: string;
  userId: string;
  userDisplayName?: string;
  message: string;
  createdAtMs: number;
  replyToMessageId?: string;
};

type VideoItem = {
  id: string;
  fileName: string;
  sizeBytes: number;
  modifiedAtMs: number;
  streamPath: string;
};

type RequestLike = {
  protocol: string;
  hostname: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
};

type WsClientMessage =
  | {
      type: "playback";
      action: PlaybackAction;
      atTimeSec?: number;
      videoId?: string;
    }
  | {
      type: "chat";
      message: string;
      replyToMessageId?: string;
    }
  | {
      type: "sync";
    }
  | {
      type: "profile";
      action: "setNickname";
      nickname: string;
    }
  | {
      type: "ping";
    };

type WsServerMessage =
  | {
      type: "welcome";
      room: RoomResponse;
      messages: ChatMessage[];
    }
  | {
      type: "room_state";
      room: RoomResponse;
      reason:
        | "join"
        | "leave"
        | "playback"
        | "video_change"
        | "sync"
        | "nickname_change";
      byUserId: string;
      byDisplayName?: string;
      action?: PlaybackAction;
    }
  | {
      type: "chat_message";
      message: ChatMessage;
      revision: number;
    }
  | {
      type: "pong";
      at: string;
    }
  | {
      type: "error";
      error: string;
    };

type RoomResponse = {
  roomId: string;
  creatorId: string;
  inviteToken: string;
  shareUrl: string;
  memberCount: number;
  members: MemberProfile[];
  revision: number;
  playback: PlaybackState;
};

const rooms = new Map<string, Room>();
const chatByRoom = new Map<string, ChatMessage[]>();
const socketsByRoom = new Map<string, Set<WebSocket>>();
const socketUserByConnection = new WeakMap<WebSocket, string>();
type PendingPlaybackMeta = {
  room: Room;
  request?: RequestLike;
  userId: string;
  excludeSocket?: WebSocket;
  playback: PlaybackState;
};
type PendingPlaybackBurst = {
  timeout: NodeJS.Timeout;
  events: PlaybackBurstEvent<PendingPlaybackMeta>[];
};
const pendingPlaybackBurstsByRoomUser = new Map<string, PendingPlaybackBurst>();
const recentPauseByRoomUser = new Map<string, number>();

const app = Fastify({ logger: true });
app.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: "*",
});

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v"]);
const dataDir = path.resolve(process.cwd(), env.DATA_DIR);
const SEEK_EPSILON_SEC = 1;
const CONTROL_LEASE_MS = 2000;
const PLAYBACK_SYNC_INTERVAL_MS = 2000;
const PLAYBACK_DEDUPE_WINDOW_MS = 250;
const SEEK_PAUSE_NOISE_WINDOW_MS = 500;

const nowMs = (): number => Date.now();

const newId = (): string => crypto.randomUUID();

const toVideoId = (fileName: string): string =>
  Buffer.from(fileName).toString("base64url");

const fromVideoId = (videoId: string): string | null => {
  try {
    return Buffer.from(videoId, "base64url").toString("utf8");
  } catch {
    return null;
  }
};

const streamPathForVideoId = (videoId: string): string =>
  `/videos/${videoId}/stream`;

const contentTypeForVideo = (fileName: string): string => {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".webm") {
    return "video/webm";
  }
  if (ext === ".mkv") {
    return "video/x-matroska";
  }
  if (ext === ".mov") {
    return "video/quicktime";
  }
  if (ext === ".m4v") {
    return "video/x-m4v";
  }
  return "video/mp4";
};

const parseSingleRange = (
  rangeHeader: string,
  sizeBytes: number,
): { start: number; end: number } | null => {
  // Support only a single bytes range.
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }

  const rawStart = match[1];
  const rawEnd = match[2];

  if (!rawStart && !rawEnd) {
    return null;
  }

  // Suffix form: bytes=-500 (last 500 bytes)
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }

    const chunkSize = Math.min(sizeBytes, Math.floor(suffixLength));
    return {
      start: Math.max(0, sizeBytes - chunkSize),
      end: sizeBytes - 1,
    };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0 || start >= sizeBytes) {
    return null;
  }

  if (!rawEnd) {
    return { start, end: sizeBytes - 1 };
  }

  const parsedEnd = Number(rawEnd);
  if (!Number.isFinite(parsedEnd) || parsedEnd < start) {
    return null;
  }

  // Clamp end so requests like bytes=0-999999999 are still satisfiable.
  const end = Math.min(sizeBytes - 1, Math.floor(parsedEnd));
  return { start, end };
};

const getBaseUrl = (request: RequestLike): string => {
  if (env.PUBLIC_BASE_URL) {
    return env.PUBLIC_BASE_URL;
  }

  const hostHeader = request.headers.host;
  const host =
    typeof hostHeader === "string" && hostHeader.length > 0
      ? hostHeader
      : `${request.hostname}:${env.PORT}`;
  return `${request.protocol}://${host}`;
};

const getServerBaseUrl = (): string => {
  if (env.PUBLIC_BASE_URL) {
    return env.PUBLIC_BASE_URL;
  }
  return `http://${env.HOST}:${env.PORT}`;
};

const playbackSummary = (playback: PlaybackState): string => {
  const minutes = (playback.playbackTimeSec / 60).toFixed(2);
  return `${playback.playbackTimeSec.toFixed(2)}s (${minutes}m)`;
};

const normalizeNickname = (value: string | undefined): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 32);
};

const getMemberProfile = (room: Room, userId: string): MemberProfile => {
  const existing = room.memberProfiles.get(userId);
  if (existing) {
    return existing;
  }
  const fallback = { userId, nickname: userId };
  room.memberProfiles.set(userId, fallback);
  return fallback;
};

const getDisplayNameForUser = (room: Room, userId: string): string =>
  getMemberProfile(room, userId).nickname;

const setNicknameForUser = (
  room: Room,
  userId: string,
  nickname: string,
): "updated" | "unchanged" | "invalid" => {
  const nextNickname = normalizeNickname(nickname);
  if (!nextNickname) {
    return "invalid";
  }
  const current = getMemberProfile(room, userId);
  if (current.nickname === nextNickname) {
    return "unchanged";
  }
  room.memberProfiles.set(userId, {
    userId,
    nickname: nextNickname,
  });
  return "updated";
};

type WsRouteRequestLike = {
  params?: { roomId?: string };
  query?: { userId?: string; inviteToken?: string; nickname?: string };
  url?: string;
  raw?: { url?: string };
};

const getRequestUrl = (request: WsRouteRequestLike): string =>
  request.url ?? request.raw?.url ?? "";

const getWsRoomId = (request: WsRouteRequestLike): string | null => {
  if (request.params?.roomId) {
    return request.params.roomId;
  }

  const match = /^\/rooms\/([^/]+)\/ws(?:\?|$)/.exec(getRequestUrl(request));
  if (!match?.[1]) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

const getWsQuery = (request: WsRouteRequestLike): {
  userId?: string;
  inviteToken?: string;
  nickname?: string;
} => {
  if (request.query) {
    return request.query;
  }

  const url = getRequestUrl(request);
  const rawQuery = url.includes("?") ? (url.split("?")[1] ?? "") : "";
  const params = new URLSearchParams(rawQuery);
  const userId = params.get("userId") ?? undefined;
  const inviteToken = params.get("inviteToken") ?? undefined;
  const nickname = params.get("nickname") ?? undefined;
  return { userId, inviteToken, nickname };
};

const normalizePlayback = (playback: PlaybackState): PlaybackState => {
  if (!playback.isPlaying) {
    return playback;
  }

  const currentMs = nowMs();
  const elapsedSec = Math.max(0, (currentMs - playback.lastUpdatedAtMs) / 1000);
  return {
    ...playback,
    playbackTimeSec: Math.max(0, playback.playbackTimeSec + elapsedSec),
    lastUpdatedAtMs: currentMs,
  };
};

const getRoomOr404 = (roomId: string): Room | null => rooms.get(roomId) ?? null;

const listVideos = async (): Promise<VideoItem[]> => {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = entries.filter((entry) => entry.isFile());
  const videos: VideoItem[] = [];

  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) {
      continue;
    }

    const fullPath = path.join(dataDir, file.name);
    const stat = await fsp.stat(fullPath);
    const id = toVideoId(file.name);

    videos.push({
      id,
      fileName: file.name,
      sizeBytes: stat.size,
      modifiedAtMs: stat.mtimeMs,
      streamPath: streamPathForVideoId(id),
    });
  }

  videos.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  return videos;
};

const getVideoById = async (videoId: string): Promise<VideoItem | null> => {
  const fileName = fromVideoId(videoId);
  if (!fileName) {
    return null;
  }

  const fullPath = path.join(dataDir, fileName);
  const normalized = path.normalize(fullPath);
  if (!normalized.startsWith(dataDir + path.sep) && normalized !== dataDir) {
    return null;
  }

  const ext = path.extname(fileName).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    return null;
  }

  try {
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile()) {
      return null;
    }

    return {
      id: videoId,
      fileName,
      sizeBytes: stat.size,
      modifiedAtMs: stat.mtimeMs,
      streamPath: streamPathForVideoId(videoId),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const roomResponse = (room: Room, request?: RequestLike): RoomResponse => {
  const baseUrl = request ? getBaseUrl(request) : getServerBaseUrl();
  const shareUrl = `${baseUrl}/room/${room.id}?token=${room.inviteToken}`;
  const members = [...room.members]
    .map((userId) => getMemberProfile(room, userId))
    .sort((a, b) => a.nickname.localeCompare(b.nickname));
  return {
    roomId: room.id,
    creatorId: room.creatorId,
    inviteToken: room.inviteToken,
    shareUrl,
    memberCount: room.members.size,
    members,
    revision: room.revision,
    playback: room.playback,
  };
};

const sendWs = (socket: WebSocket, payload: WsServerMessage): void => {
  if (socket.readyState !== socket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
};

const broadcastRoomState = (
  room: Room,
  request: RequestLike | undefined,
  byUserId: string,
  reason:
    | "join"
    | "leave"
    | "playback"
    | "video_change"
    | "sync"
    | "nickname_change",
  action?: PlaybackAction,
  excludeSocket?: WebSocket,
  byDisplayName?: string,
): void => {
  const roomSockets = socketsByRoom.get(room.id);
  if (!roomSockets || roomSockets.size === 0) {
    return;
  }

  const payload: WsServerMessage = {
    type: "room_state",
    room: roomResponse(room, request),
    reason,
    byUserId,
    byDisplayName: byDisplayName ?? getDisplayNameForUser(room, byUserId),
    action,
  };

  for (const socket of roomSockets) {
    if (excludeSocket && socket === excludeSocket) {
      continue;
    }
    sendWs(socket, payload);
  }
};

const sendRoomStateToSocket = (
  socket: WebSocket,
  room: Room,
  request: RequestLike | undefined,
  byUserId: string,
  reason:
    | "join"
    | "leave"
    | "playback"
    | "video_change"
    | "sync"
    | "nickname_change",
  action?: PlaybackAction,
): void => {
  sendWs(socket, {
    type: "room_state",
    room: roomResponse(room, request),
    reason,
    byUserId,
    byDisplayName: getDisplayNameForUser(room, byUserId),
    action,
  });
};

const roomUserDedupeKey = (roomId: string, userId: string): string =>
  `${roomId}:${userId}`;

const flushPendingPlaybackBurst = (roomId: string, userId: string): void => {
  const key = roomUserDedupeKey(roomId, userId);
  const pending = pendingPlaybackBurstsByRoomUser.get(key);
  if (!pending) {
    return;
  }
  pendingPlaybackBurstsByRoomUser.delete(key);

  const dedupedEvents = dedupePlaybackBurst(pending.events);
  for (const event of dedupedEvents) {
    const { room, request, excludeSocket } = event.meta;

    broadcastRoomState(room, request, userId, "playback", event.action, excludeSocket);
  }
};

const enqueuePlaybackBurstEvent = (
  room: Room,
  request: RequestLike | undefined,
  userId: string,
  action: DedupablePlaybackAction,
  excludeSocket: WebSocket | undefined,
): void => {
  const key = roomUserDedupeKey(room.id, userId);
  const pending = pendingPlaybackBurstsByRoomUser.get(key);
  const event: PlaybackBurstEvent<PendingPlaybackMeta> = {
    action,
    playbackTimeSec: room.playback.playbackTimeSec,
    meta: {
      room,
      request,
      userId,
      excludeSocket,
      playback: room.playback,
    },
  };

  if (!pending) {
    const timeout = setTimeout(() => {
      flushPendingPlaybackBurst(room.id, userId);
    }, PLAYBACK_DEDUPE_WINDOW_MS);
    timeout.unref();
    pendingPlaybackBurstsByRoomUser.set(key, {
      timeout,
      events: [event],
    });
    return;
  }

  pending.events.push(event);
  clearTimeout(pending.timeout);
  pending.timeout = setTimeout(() => {
    flushPendingPlaybackBurst(room.id, userId);
  }, PLAYBACK_DEDUPE_WINDOW_MS);
  pending.timeout.unref();
};

const hasOpenSocketForUser = (
  roomId: string,
  userId: string,
  excludeSocket?: WebSocket,
): boolean => {
  const roomSockets = socketsByRoom.get(roomId);
  if (!roomSockets || roomSockets.size === 0) {
    return false;
  }

  for (const socket of roomSockets) {
    if (excludeSocket && socket === excludeSocket) {
      continue;
    }
    if (socketUserByConnection.get(socket) === userId) {
      return true;
    }
  }
  return false;
};

const removeMemberFromRoom = (room: Room, userId: string): boolean => {
  if (!room.members.has(userId)) {
    return false;
  }

  const key = roomUserDedupeKey(room.id, userId);
  const pendingPlaybackBurst = pendingPlaybackBurstsByRoomUser.get(key);
  if (pendingPlaybackBurst) {
    clearTimeout(pendingPlaybackBurst.timeout);
    pendingPlaybackBurstsByRoomUser.delete(key);
  }
  recentPauseByRoomUser.delete(key);

  room.members.delete(userId);
  room.memberProfiles.delete(userId);
  if (room.activeControllerId === userId) {
    room.activeControllerId = null;
    room.activeControllerUntilMs = 0;
  }
  room.revision += 1;
  return true;
};

const periodicPlaybackSync = setInterval(() => {
  const currentMs = nowMs();
  for (const [roomId, roomSockets] of socketsByRoom.entries()) {
    if (roomSockets.size === 0) {
      continue;
    }

    const room = rooms.get(roomId);
    if (!room || !room.playback.isPlaying) {
      continue;
    }

    room.playback = normalizePlayback(room.playback);

    const payload: WsServerMessage = {
      type: "room_state",
      room: roomResponse(room),
      reason: "sync",
      byUserId: "system",
    };

    for (const socket of roomSockets) {
      if (
        room.activeControllerId &&
        currentMs <= room.activeControllerUntilMs &&
        socketUserByConnection.get(socket) === room.activeControllerId
      ) {
        continue;
      }
      sendWs(socket, payload);
    }
  }
}, PLAYBACK_SYNC_INTERVAL_MS);

periodicPlaybackSync.unref();

const applyPlaybackAction = async (
  room: Room,
  action: PlaybackAction,
  atTimeSec?: number,
  videoId?: string,
): Promise<
  | { ok: true; changed: boolean }
  | { ok: false; error: string }
> => {
  const playback = normalizePlayback(room.playback);
  const currentMs = nowMs();
  let changed = false;

  if (action === "play") {
    if (!playback.isPlaying) {
      room.playback = {
        ...playback,
        isPlaying: true,
        lastUpdatedAtMs: currentMs,
      };
      changed = true;
    }
  }

  if (action === "pause") {
    if (playback.isPlaying) {
      room.playback = {
        ...playback,
        isPlaying: false,
        lastUpdatedAtMs: currentMs,
      };
      changed = true;
    }
  }

  if (action === "seek") {
    if (typeof atTimeSec !== "number" || atTimeSec < 0) {
      return { ok: false, error: "invalid_seek_time" };
    }
    if (Math.abs(playback.playbackTimeSec - atTimeSec) > SEEK_EPSILON_SEC) {
      room.playback = {
        ...playback,
        playbackTimeSec: atTimeSec,
        lastUpdatedAtMs: currentMs,
      };
      changed = true;
    }
  }

  if (action === "changeVideo") {
    if (!videoId) {
      return { ok: false, error: "missing_video_id" };
    }

    const video = await getVideoById(videoId);
    if (!video) {
      return { ok: false, error: "video_not_found" };
    }

    if (playback.videoId !== video.id) {
      room.playback = {
        videoId: video.id,
        videoUrl: video.streamPath,
        playbackTimeSec: 0,
        isPlaying: false,
        lastUpdatedAtMs: currentMs,
      };
      changed = true;
    }
  }

  if (changed) {
    room.revision += 1;
  }

  return { ok: true, changed };
};

const acquireControlLease = (room: Room, userId: string): boolean => {
  const currentMs = nowMs();

  if (
    room.activeControllerId === null ||
    room.activeControllerId === userId ||
    currentMs > room.activeControllerUntilMs
  ) {
    room.activeControllerId = userId;
    room.activeControllerUntilMs = currentMs + CONTROL_LEASE_MS;
    return true;
  }

  return false;
};

app.get("/health", async () => ({
  ok: true,
  service: "simple-stream-party",
  at: new Date().toISOString(),
}));

app.get("/videos", async (request) => {
  const videos = await listVideos();
  const baseUrl = getBaseUrl(request);
  return {
    dataDir,
    count: videos.length,
    videos: videos.map((video) => ({
      id: video.id,
      fileName: video.fileName,
      sizeBytes: video.sizeBytes,
      modifiedAtMs: video.modifiedAtMs,
      streamUrl: `${baseUrl}${video.streamPath}`,
    })),
  };
});

app.get<{
  Params: { videoId: string };
}>("/videos/:videoId/stream", async (request, reply) => {
  const { videoId } = request.params;
  const video = await getVideoById(videoId);
  if (!video) {
    reply.code(404);
    return { error: "video_not_found" };
  }

  const fullPath = path.join(dataDir, video.fileName);
  const rangeHeader = request.headers.range;
  const contentType = contentTypeForVideo(video.fileName);

  if (!rangeHeader) {
    reply.header("Content-Type", contentType);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Length", video.sizeBytes.toString());
    return reply.send(fs.createReadStream(fullPath));
  }

  const range = parseSingleRange(rangeHeader, video.sizeBytes);
  if (!range) {
    reply.code(416);
    reply.header("Content-Range", `bytes */${video.sizeBytes}`);
    return { error: "invalid_range" };
  }

  const { start, end } = range;

  const chunkSize = end - start + 1;
  reply.code(206);
  reply.header("Content-Type", contentType);
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Length", chunkSize.toString());
  reply.header("Content-Range", `bytes ${start}-${end}/${video.sizeBytes}`);
  return reply.send(fs.createReadStream(fullPath, { start, end }));
});

app.post<{
  Body: {
    creatorId: string;
    videoId: string;
    creatorNickname?: string;
  };
}>("/rooms/from-video", async (request, reply) => {
  const { creatorId, videoId, creatorNickname } = request.body;
  const video = await getVideoById(videoId);
  if (!video) {
    reply.code(404);
    return { error: "video_not_found" };
  }

  const room: Room = {
    id: newId(),
    creatorId,
    inviteToken: newId(),
    members: new Set([creatorId]),
    memberProfiles: new Map([
      [
        creatorId,
        {
          userId: creatorId,
          nickname: normalizeNickname(creatorNickname) ?? creatorId,
        },
      ],
    ]),
    playback: {
      videoId: video.id,
      videoUrl: video.streamPath,
      playbackTimeSec: 0,
      isPlaying: false,
      lastUpdatedAtMs: nowMs(),
    },
    createdAtMs: nowMs(),
    revision: 1,
    activeControllerId: creatorId,
    activeControllerUntilMs: nowMs() + CONTROL_LEASE_MS,
  };

  rooms.set(room.id, room);
  chatByRoom.set(room.id, []);

  reply.code(201);
  return roomResponse(room, request);
});

app.post<{
  Params: {
    roomId: string;
  };
  Body: {
    userId: string;
    inviteToken: string;
  };
}>("/rooms/:roomId/leave", async (request, reply) => {
  const { roomId } = request.params;
  const { userId, inviteToken } = request.body;
  const trimmedUserId = userId?.trim();

  if (!trimmedUserId) {
    reply.code(400);
    return { error: "missing_user_id" };
  }

  const room = getRoomOr404(roomId);
  if (!room) {
    reply.code(404);
    return { error: "room_not_found" };
  }

  if (inviteToken !== room.inviteToken) {
    reply.code(403);
    return { error: "invalid_invite_token" };
  }

  const displayNameBeforeLeave = getDisplayNameForUser(room, trimmedUserId);
  const didLeave = removeMemberFromRoom(room, trimmedUserId);
  if (didLeave) {
    broadcastRoomState(
      room,
      request,
      trimmedUserId,
      "leave",
      undefined,
      undefined,
      displayNameBeforeLeave,
    );
  }

  const roomSockets = socketsByRoom.get(room.id);
  if (roomSockets) {
    for (const socket of roomSockets) {
      if (socketUserByConnection.get(socket) === trimmedUserId) {
        socket.close(1000, "left_room");
      }
    }
  }

  return {
    left: didLeave,
    room: roomResponse(room, request),
  };
});

app.register(async (wsApp) => {
  await wsApp.register(websocket, {
    options: {
      verifyClient: () => true,
    },
  });

  wsApp.get<{
    Params: { roomId: string };
    Querystring: {
      userId?: string;
      inviteToken?: string;
      nickname?: string;
    };
  }>("/rooms/:roomId/ws", { websocket: true }, (socket, request): void => {
    const roomId = getWsRoomId(request);
    const { userId, inviteToken, nickname } = getWsQuery(request);

    if (!roomId) {
      sendWs(socket, { type: "error", error: "room_not_found" });
      socket.close();
      return;
    }

    const room = getRoomOr404(roomId);

    if (!room) {
      sendWs(socket, { type: "error", error: "room_not_found" });
      socket.close();
      return;
    }

    if (!userId) {
      sendWs(socket, { type: "error", error: "missing_user_id" });
      socket.close();
      return;
    }

    if (inviteToken !== room.inviteToken) {
      sendWs(socket, { type: "error", error: "invalid_invite_token" });
      socket.close();
      return;
    }

    app.log.info(
      {
        event: "room_join",
        roomId: room.id,
        userId,
      },
      "User joined room",
    );

    room.members.add(userId);
    if (nickname) {
      const setResult = setNicknameForUser(room, userId, nickname);
      if (setResult === "invalid") {
        sendWs(socket, { type: "error", error: "invalid_nickname" });
        socket.close();
        return;
      }
    } else {
      getMemberProfile(room, userId);
    }
    room.playback = normalizePlayback(room.playback);
    room.revision += 1;

    const roomSockets = socketsByRoom.get(room.id) ?? new Set<WebSocket>();
    roomSockets.add(socket);
    socketsByRoom.set(room.id, roomSockets);
    socketUserByConnection.set(socket, userId);

    sendWs(socket, {
      type: "welcome",
      room: roomResponse(room, request),
      messages: chatByRoom.get(room.id) ?? [],
    });
    broadcastRoomState(room, request, userId, "join", undefined, socket);

    socket.on("message", async (raw: RawData): Promise<void> => {
      let payload: WsClientMessage;
      try {
        payload = JSON.parse(raw.toString()) as WsClientMessage;
      } catch {
        sendWs(socket, { type: "error", error: "invalid_json" });
        return;
      }

      if (payload.type === "ping") {
        sendWs(socket, { type: "pong", at: new Date().toISOString() });
        return;
      }

      if (payload.type === "sync") {
        room.playback = normalizePlayback(room.playback);
        sendWs(socket, {
          type: "room_state",
          room: roomResponse(room, request),
          reason: "sync",
          byUserId: userId,
          byDisplayName: getDisplayNameForUser(room, userId),
        });
        return;
      }

      if (payload.type === "profile") {
        if (payload.action !== "setNickname") {
          sendWs(socket, { type: "error", error: "invalid_profile_action" });
          return;
        }

        const setResult = setNicknameForUser(room, userId, payload.nickname);
        if (setResult === "invalid") {
          sendWs(socket, { type: "error", error: "invalid_nickname" });
          return;
        }
        if (setResult === "unchanged") {
          return;
        }

        room.revision += 1;
        broadcastRoomState(room, request, userId, "nickname_change", undefined, socket);
        sendWs(socket, {
          type: "room_state",
          room: roomResponse(room, request),
          reason: "nickname_change",
          byUserId: userId,
          byDisplayName: getDisplayNameForUser(room, userId),
        });
        return;
      }

      if (payload.type === "playback") {
        const playbackBeforeAction = room.playback;
        const roomUserKey = roomUserDedupeKey(room.id, userId);

        if (!acquireControlLease(room, userId)) {
          app.log.info(
            {
              event: "playback_rejected_control_lease",
              roomId: room.id,
              userId,
              action: payload.action,
              activeControllerId: room.activeControllerId,
              activeControllerUntilMs: room.activeControllerUntilMs,
            },
            "Playback action rejected because control lease is held by another user",
          );
          return;
        }

        const result = await applyPlaybackAction(
          room,
          payload.action,
          payload.atTimeSec,
          payload.videoId,
        );

        if (!result.ok) {
          app.log.warn(
            {
              event: "playback_rejected_invalid_action",
              roomId: room.id,
              userId,
              action: payload.action,
              atTimeSec: payload.atTimeSec,
              videoId: payload.videoId,
              error: result.error,
            },
            "Playback action rejected",
          );
          sendWs(socket, { type: "error", error: result.error });
          return;
        }

        if (!result.changed) {
          app.log.info(
            {
              event: "playback_ignored_no_change",
              roomId: room.id,
              userId,
              action: payload.action,
              atTimeSec: payload.atTimeSec,
              videoId: payload.videoId,
              playbackTime: playbackSummary(room.playback),
            },
            "Playback action ignored because state is unchanged",
          );
          return;
        }

        if (payload.action === "pause" && playbackBeforeAction.isPlaying) {
          recentPauseByRoomUser.set(roomUserKey, nowMs());
        } else if (payload.action !== "seek") {
          recentPauseByRoomUser.delete(roomUserKey);
        }

        if (payload.action === "seek" && !room.playback.isPlaying) {
          const pausedAtMs = recentPauseByRoomUser.get(roomUserKey);
          if (
            typeof pausedAtMs === "number" &&
            nowMs() - pausedAtMs <= SEEK_PAUSE_NOISE_WINDOW_MS
          ) {
            room.playback = {
              ...room.playback,
              isPlaying: true,
              lastUpdatedAtMs: nowMs(),
            };
            room.revision += 1;
          }
          recentPauseByRoomUser.delete(roomUserKey);
        }

        app.log.info(
          {
            event: "playback_action_applied",
            roomId: room.id,
            userId,
            action: payload.action,
            atTimeSec: payload.atTimeSec,
            atMinute:
              typeof payload.atTimeSec === "number"
                ? Number((payload.atTimeSec / 60).toFixed(2))
                : undefined,
            videoId: payload.videoId ?? room.playback.videoId,
            playbackTime: playbackSummary(room.playback),
            isPlaying: room.playback.isPlaying,
            revision: room.revision,
          },
          "Playback action applied",
        );

        if (payload.action === "changeVideo") {
          sendRoomStateToSocket(
            socket,
            room,
            request,
            userId,
            "video_change",
            payload.action,
          );
          broadcastRoomState(room, request, userId, "video_change", payload.action, socket);
          return;
        }

        sendRoomStateToSocket(
          socket,
          room,
          request,
          userId,
          "playback",
          payload.action,
        );
        enqueuePlaybackBurstEvent(room, request, userId, payload.action, socket);
        return;
      }

      if (payload.type === "chat") {
        const trimmed = payload.message.trim();
        if (!trimmed) {
          sendWs(socket, { type: "error", error: "message_empty" });
          return;
        }

        const rawReplyToMessageId = payload.replyToMessageId;
        const replyToMessageId =
          typeof rawReplyToMessageId === "string"
            ? rawReplyToMessageId.trim()
            : undefined;

        if (replyToMessageId === "") {
          sendWs(socket, { type: "error", error: "invalid_reply_message_id" });
          return;
        }

        const roomMessages = chatByRoom.get(room.id) ?? [];
        if (
          replyToMessageId &&
          !roomMessages.some((message) => message.id === replyToMessageId)
        ) {
          sendWs(socket, { type: "error", error: "reply_message_not_found" });
          return;
        }

        const newMessage: ChatMessage = {
          id: newId(),
          roomId: room.id,
          userId,
          userDisplayName: getDisplayNameForUser(room, userId),
          message: trimmed,
          createdAtMs: nowMs(),
          ...(replyToMessageId ? { replyToMessageId } : {}),
        };

        roomMessages.push(newMessage);
        if (roomMessages.length > 200) {
          roomMessages.shift();
        }
        chatByRoom.set(room.id, roomMessages);
        room.revision += 1;

        const roomSocketsForChat = socketsByRoom.get(room.id);
        if (!roomSocketsForChat) {
          return;
        }

        for (const ws of roomSocketsForChat) {
          sendWs(ws, {
            type: "chat_message",
            message: newMessage,
            revision: room.revision,
          });
        }
      }
    });

    socket.on("close", () => {
      app.log.info(
        {
          event: "room_leave",
          roomId: room.id,
          userId,
        },
        "User left room",
      );

      const roomSocketSet = socketsByRoom.get(room.id);
      if (!roomSocketSet) {
        return;
      }

      roomSocketSet.delete(socket);
      if (roomSocketSet.size === 0) {
        socketsByRoom.delete(room.id);
      }

      if (hasOpenSocketForUser(room.id, userId, socket)) {
        return;
      }

      const displayNameBeforeLeave = getDisplayNameForUser(room, userId);
      const didLeave = removeMemberFromRoom(room, userId);
      if (didLeave) {
        broadcastRoomState(
          room,
          request,
          userId,
          "leave",
          undefined,
          undefined,
          displayNameBeforeLeave,
        );
      }
    });
  });
});

const start = async (): Promise<void> => {
  await fsp.mkdir(dataDir, { recursive: true });

  try {
    await app.listen({
      host: env.HOST,
      port: env.PORT,
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
