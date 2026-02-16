import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import env from "./env.js";

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
  playback: PlaybackState;
  createdAtMs: number;
  revision: number;
};

type ChatMessage = {
  id: string;
  roomId: string;
  userId: string;
  message: string;
  createdAtMs: number;
};

type VideoItem = {
  id: string;
  fileName: string;
  sizeBytes: number;
  modifiedAtMs: number;
  streamPath: string;
};

const rooms = new Map<string, Room>();
const chatByRoom = new Map<string, ChatMessage[]>();

const app = Fastify({ logger: true });

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v"]);
const dataDir = path.resolve(process.cwd(), env.DATA_DIR);

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

const getBaseUrl = (request: {
  protocol: string;
  hostname: string;
  headers: Record<string, string | string[] | undefined>;
}): string => {
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

const roomResponse = (
  room: Room,
  request: {
    protocol: string;
    hostname: string;
    headers: Record<string, string | string[] | undefined>;
  },
): {
  roomId: string;
  creatorId: string;
  inviteToken: string;
  shareUrl: string;
  memberCount: number;
  revision: number;
  playback: PlaybackState;
} => {
  const baseUrl = getBaseUrl(request);
  const shareUrl = `${baseUrl}/room/${room.id}?token=${room.inviteToken}`;
  return {
    roomId: room.id,
    creatorId: room.creatorId,
    inviteToken: room.inviteToken,
    shareUrl,
    memberCount: room.members.size,
    revision: room.revision,
    playback: room.playback,
  };
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
  const contentType =
    path.extname(video.fileName).toLowerCase() === ".webm"
      ? "video/webm"
      : "video/mp4";

  if (!rangeHeader) {
    reply.header("Content-Type", contentType);
    reply.header("Content-Length", video.sizeBytes.toString());
    return reply.send(fs.createReadStream(fullPath));
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    reply.code(416);
    reply.header("Content-Range", `bytes */${video.sizeBytes}`);
    return { error: "invalid_range" };
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : video.sizeBytes - 1;

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end < start ||
    end >= video.sizeBytes
  ) {
    reply.code(416);
    reply.header("Content-Range", `bytes */${video.sizeBytes}`);
    return { error: "range_not_satisfiable" };
  }

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
  };
}>("/rooms/from-video", async (request, reply) => {
  const { creatorId, videoId } = request.body;
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
    playback: {
      videoId: video.id,
      videoUrl: video.streamPath,
      playbackTimeSec: 0,
      isPlaying: false,
      lastUpdatedAtMs: nowMs(),
    },
    createdAtMs: nowMs(),
    revision: 1,
  };

  rooms.set(room.id, room);
  chatByRoom.set(room.id, []);

  reply.code(201);
  return roomResponse(room, request);
});

app.post<{
  Params: { roomId: string };
  Body: {
    userId: string;
    inviteToken: string;
  };
}>("/rooms/:roomId/join", async (request, reply) => {
  const { roomId } = request.params;
  const { userId, inviteToken } = request.body;

  const room = getRoomOr404(roomId);
  if (!room) {
    reply.code(404);
    return { error: "room_not_found" };
  }

  if (inviteToken !== room.inviteToken) {
    reply.code(403);
    return { error: "invalid_invite_token" };
  }

  room.members.add(userId);
  room.playback = normalizePlayback(room.playback);
  room.revision += 1;

  return roomResponse(room, request);
});

app.get<{
  Params: { roomId: string };
}>("/rooms/:roomId/state", async (request, reply) => {
  const { roomId } = request.params;
  const room = getRoomOr404(roomId);

  if (!room) {
    reply.code(404);
    return { error: "room_not_found" };
  }

  room.playback = normalizePlayback(room.playback);
  return roomResponse(room, request);
});

app.post<{
  Params: { roomId: string };
  Body: {
    userId: string;
    action: PlaybackAction;
    atTimeSec?: number;
    videoId?: string;
  };
}>("/rooms/:roomId/playback", async (request, reply) => {
  const { roomId } = request.params;
  const { userId, action, atTimeSec, videoId } = request.body;
  const room = getRoomOr404(roomId);

  if (!room) {
    reply.code(404);
    return { error: "room_not_found" };
  }

  if (!room.members.has(userId)) {
    reply.code(403);
    return { error: "user_not_in_room" };
  }

  const playback = normalizePlayback(room.playback);
  const currentMs = nowMs();

  if (action === "play") {
    room.playback = {
      ...playback,
      isPlaying: true,
      lastUpdatedAtMs: currentMs,
    };
  }

  if (action === "pause") {
    room.playback = {
      ...playback,
      isPlaying: false,
      lastUpdatedAtMs: currentMs,
    };
  }

  if (action === "seek") {
    if (typeof atTimeSec !== "number" || atTimeSec < 0) {
      reply.code(400);
      return { error: "invalid_seek_time" };
    }
    room.playback = {
      ...playback,
      playbackTimeSec: atTimeSec,
      lastUpdatedAtMs: currentMs,
    };
  }

  if (action === "changeVideo") {
    if (!videoId) {
      reply.code(400);
      return { error: "missing_video_id" };
    }

    const video = await getVideoById(videoId);
    if (!video) {
      reply.code(404);
      return { error: "video_not_found" };
    }

    room.playback = {
      videoId: video.id,
      videoUrl: video.streamPath,
      playbackTimeSec: 0,
      isPlaying: false,
      lastUpdatedAtMs: currentMs,
    };
  }

  room.revision += 1;

  return {
    roomId: room.id,
    revision: room.revision,
    action,
    byUserId: userId,
    playback: room.playback,
  };
});

app.post<{
  Params: { roomId: string };
  Body: {
    userId: string;
    message: string;
  };
}>("/rooms/:roomId/chat", async (request, reply) => {
  const { roomId } = request.params;
  const { userId, message } = request.body;
  const room = getRoomOr404(roomId);

  if (!room) {
    reply.code(404);
    return { error: "room_not_found" };
  }

  if (!room.members.has(userId)) {
    reply.code(403);
    return { error: "user_not_in_room" };
  }

  const trimmed = message.trim();
  if (!trimmed) {
    reply.code(400);
    return { error: "message_empty" };
  }

  const newMessage: ChatMessage = {
    id: newId(),
    roomId,
    userId,
    message: trimmed,
    createdAtMs: nowMs(),
  };

  const roomMessages = chatByRoom.get(roomId) ?? [];
  roomMessages.push(newMessage);
  if (roomMessages.length > 200) {
    roomMessages.shift();
  }
  chatByRoom.set(roomId, roomMessages);
  room.revision += 1;

  reply.code(201);
  return newMessage;
});

app.get<{
  Params: { roomId: string };
}>("/rooms/:roomId/chat", async (request, reply) => {
  const { roomId } = request.params;
  const room = getRoomOr404(roomId);

  if (!room) {
    reply.code(404);
    return { error: "room_not_found" };
  }

  return {
    roomId,
    revision: room.revision,
    messages: chatByRoom.get(roomId) ?? [],
  };
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
