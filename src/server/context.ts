import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  DedupablePlaybackAction,
  PlaybackBurstEvent,
} from "../playback-dedupe.js";
import { dedupePlaybackBurst } from "../playback-dedupe.js";
import env from "../env.js";
import type {
  ChatMessage,
  MemberProfile,
  PlaybackAction,
  PlaybackState,
  RequestLike,
  Room,
  RoomResponse,
  RoomStateReason,
  SubtitleFormat,
  SubtitleItem,
  SubtitleState,
  VideoItem,
  WsConnection,
  WsServerMessage,
} from "./types.js";

type PendingPlaybackMeta = {
  room: Room;
  request?: RequestLike;
  userId: string;
  excludeSocket?: WsConnection;
  playback: PlaybackState;
};

type PendingPlaybackBurst = {
  timeout: NodeJS.Timeout;
  events: PlaybackBurstEvent<PendingPlaybackMeta>[];
};

export type ServerContext = {
  rooms: Map<string, Room>;
  chatByRoom: Map<string, ChatMessage[]>;
  socketsByRoom: Map<string, Set<WsConnection>>;
  socketUserByConnection: WeakMap<WsConnection, string>;
  recentPauseByRoomUser: Map<string, number>;
  dataDir: string;
  subtitlesDir: string;
  controlLeaseMs: number;
  seekPauseNoiseWindowMs: number;
  maxSubtitleUploadBytes: number;
  nowMs: () => number;
  newId: () => string;
  toSubtitleId: (fileName: string) => string;
  trackPathForSubtitleId: (subtitleId: string) => string;
  contentTypeForVideo: (fileName: string) => string;
  subtitleFormatForFileName: (fileName: string) => SubtitleFormat | null;
  parseSingleRange: (
    rangeHeader: string,
    sizeBytes: number,
  ) => { start: number; end: number } | null;
  getBaseUrl: (request: RequestLike) => string;
  playbackSummary: (playback: PlaybackState) => string;
  normalizeNickname: (value: string | undefined) => string | undefined;
  toSafeSubtitleFileName: (value: string) => string | null;
  getMemberProfile: (room: Room, userId: string) => MemberProfile;
  getDisplayNameForUser: (room: Room, userId: string) => string;
  setNicknameForUser: (
    room: Room,
    userId: string,
    nickname: string,
  ) => "updated" | "unchanged" | "invalid";
  normalizePlayback: (playback: PlaybackState) => PlaybackState;
  getRoomOr404: (roomId: string) => Room | null;
  listVideos: () => Promise<VideoItem[]>;
  getVideoById: (videoId: string) => Promise<VideoItem | null>;
  listSubtitles: () => Promise<SubtitleItem[]>;
  getSubtitleById: (subtitleId: string) => Promise<SubtitleItem | null>;
  readSubtitleAsVtt: (subtitle: SubtitleItem) => Promise<string>;
  roomResponse: (room: Room, request?: RequestLike) => RoomResponse;
  sendWs: (socket: WsConnection, payload: WsServerMessage) => void;
  broadcastRoomState: (
    room: Room,
    request: RequestLike | undefined,
    byUserId: string,
    reason: RoomStateReason,
    action?: PlaybackAction,
    excludeSocket?: WsConnection,
    byDisplayName?: string,
  ) => void;
  sendRoomStateToSocket: (
    socket: WsConnection,
    room: Room,
    request: RequestLike | undefined,
    byUserId: string,
    reason: RoomStateReason,
    action?: PlaybackAction,
  ) => void;
  roomUserDedupeKey: (roomId: string, userId: string) => string;
  enqueuePlaybackBurstEvent: (
    room: Room,
    request: RequestLike | undefined,
    userId: string,
    action: DedupablePlaybackAction,
    excludeSocket: WsConnection | undefined,
  ) => void;
  hasOpenSocketForUser: (
    roomId: string,
    userId: string,
    excludeSocket?: WsConnection,
  ) => boolean;
  removeMemberFromRoom: (room: Room, userId: string) => boolean;
  applyPlaybackAction: (
    room: Room,
    action: PlaybackAction,
    atTimeSec?: number,
    videoId?: string,
    subtitleId?: string,
    subtitleUrl?: string,
    subtitleLabel?: string,
    subtitleLanguage?: string,
  ) => Promise<{ ok: true; changed: boolean } | { ok: false; error: string }>;
  acquireControlLease: (room: Room, userId: string) => boolean;
};

export const createServerContext = (): ServerContext => {
  const rooms = new Map<string, Room>();
  const chatByRoom = new Map<string, ChatMessage[]>();
  const socketsByRoom = new Map<string, Set<WsConnection>>();
  const socketUserByConnection = new WeakMap<WsConnection, string>();
  const pendingPlaybackBurstsByRoomUser = new Map<
    string,
    PendingPlaybackBurst
  >();
  const recentPauseByRoomUser = new Map<string, number>();

  const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v"]);
  const SUBTITLE_EXTENSIONS = new Set([".vtt", ".srt"]);
  const dataDir = path.resolve(process.cwd(), env.DATA_DIR);
  const subtitlesDir = path.join(dataDir, "subtitles");
  const SEEK_EPSILON_SEC = 1;
  const CONTROL_LEASE_MS = 2000;
  const PLAYBACK_SYNC_INTERVAL_MS = 2000;
  const PLAYBACK_DEDUPE_WINDOW_MS = 250;
  const SEEK_PAUSE_NOISE_WINDOW_MS = 500;
  const MAX_SUBTITLE_UPLOAD_BYTES = 2 * 1024 * 1024;

  const nowMs = (): number => Date.now();

  const newId = (): string => crypto.randomUUID();

  const toVideoId = (fileName: string): string =>
    Buffer.from(fileName).toString("base64url");

  const toSubtitleId = (fileName: string): string =>
    Buffer.from(fileName).toString("base64url");

  const fromVideoId = (videoId: string): string | null => {
    try {
      return Buffer.from(videoId, "base64url").toString("utf8");
    } catch {
      return null;
    }
  };

  const fromSubtitleId = (subtitleId: string): string | null => {
    try {
      return Buffer.from(subtitleId, "base64url").toString("utf8");
    } catch {
      return null;
    }
  };

  const streamPathForVideoId = (videoId: string): string =>
    `/videos/${videoId}/stream`;

  const trackPathForSubtitleId = (subtitleId: string): string =>
    `/subtitles/${subtitleId}/track`;

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

  const subtitleFormatForFileName = (
    fileName: string,
  ): SubtitleFormat | null => {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === ".vtt") {
      return "vtt";
    }
    if (ext === ".srt") {
      return "srt";
    }
    return null;
  };

  const ensureVttHeader = (content: string): string => {
    const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (normalized.startsWith("WEBVTT")) {
      return normalized;
    }
    return `WEBVTT\n\n${normalized}`;
  };

  const convertSrtToVtt = (srtContent: string): string => {
    const normalized = srtContent
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n");
    const withVttTimestamps = normalized.replace(
      /\b(\d{2}:\d{2}:\d{2}),(\d{3})\b/g,
      "$1.$2",
    );
    return ensureVttHeader(withVttTimestamps);
  };

  const parseSingleRange = (
    rangeHeader: string,
    sizeBytes: number,
  ): { start: number; end: number } | null => {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      return null;
    }

    const rawStart = match[1];
    const rawEnd = match[2];

    if (!rawStart && !rawEnd) {
      return null;
    }

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

  const normalizeSubtitleLabel = (
    value: string | undefined,
  ): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, 64);
  };

  const normalizeSubtitleLanguage = (
    value: string | undefined,
  ): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, 16);
  };

  const normalizeExternalSubtitleUrl = (
    value: string | undefined,
  ): string | null => {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith("/")) {
      return trimmed;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  };

  const toSafeSubtitleFileName = (value: string): string | null => {
    const base = path.basename(value).trim();
    if (!base) {
      return null;
    }
    const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
    return sanitized || null;
  };

  const isSameSubtitleState = (
    left: SubtitleState | null,
    right: SubtitleState | null,
  ): boolean => {
    if (left === right) {
      return true;
    }
    if (!left || !right) {
      return false;
    }
    return (
      left.source === right.source &&
      left.trackUrl === right.trackUrl &&
      left.label === right.label &&
      left.language === right.language
    );
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

  const normalizePlayback = (playback: PlaybackState): PlaybackState => {
    if (!playback.isPlaying) {
      return playback;
    }

    const currentMs = nowMs();
    const elapsedSec = Math.max(
      0,
      (currentMs - playback.lastUpdatedAtMs) / 1000,
    );
    return {
      ...playback,
      playbackTimeSec: Math.max(0, playback.playbackTimeSec + elapsedSec),
      lastUpdatedAtMs: currentMs,
    };
  };

  const getRoomOr404 = (roomId: string): Room | null =>
    rooms.get(roomId) ?? null;

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

  const listSubtitles = async (): Promise<SubtitleItem[]> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(subtitlesDir, { withFileTypes: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const files = entries.filter((entry) => entry.isFile());
    const subtitles: SubtitleItem[] = [];

    for (const file of files) {
      const ext = path.extname(file.name).toLowerCase();
      if (!SUBTITLE_EXTENSIONS.has(ext)) {
        continue;
      }

      const format = subtitleFormatForFileName(file.name);
      if (!format) {
        continue;
      }

      const fullPath = path.join(subtitlesDir, file.name);
      const stat = await fsp.stat(fullPath);
      const id = toSubtitleId(file.name);

      subtitles.push({
        id,
        fileName: file.name,
        sizeBytes: stat.size,
        modifiedAtMs: stat.mtimeMs,
        trackPath: trackPathForSubtitleId(id),
        format,
      });
    }

    subtitles.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
    return subtitles;
  };

  const getSubtitleById = async (
    subtitleId: string,
  ): Promise<SubtitleItem | null> => {
    const fileName = fromSubtitleId(subtitleId);
    if (!fileName) {
      return null;
    }

    const fullPath = path.join(subtitlesDir, fileName);
    const normalized = path.normalize(fullPath);
    if (
      !normalized.startsWith(subtitlesDir + path.sep) &&
      normalized !== subtitlesDir
    ) {
      return null;
    }

    const ext = path.extname(fileName).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(ext)) {
      return null;
    }

    const format = subtitleFormatForFileName(fileName);
    if (!format) {
      return null;
    }

    try {
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) {
        return null;
      }

      return {
        id: subtitleId,
        fileName,
        sizeBytes: stat.size,
        modifiedAtMs: stat.mtimeMs,
        trackPath: trackPathForSubtitleId(subtitleId),
        format,
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };

  const readSubtitleAsVtt = async (subtitle: SubtitleItem): Promise<string> => {
    const fullPath = path.join(subtitlesDir, subtitle.fileName);
    const content = await fsp.readFile(fullPath, "utf8");
    if (subtitle.format === "vtt") {
      return ensureVttHeader(content);
    }
    return convertSrtToVtt(content);
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

  const sendWs = (socket: WsConnection, payload: WsServerMessage): void => {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(payload));
  };

  const broadcastRoomState = (
    room: Room,
    request: RequestLike | undefined,
    byUserId: string,
    reason: RoomStateReason,
    action?: PlaybackAction,
    excludeSocket?: WsConnection,
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
    socket: WsConnection,
    room: Room,
    request: RequestLike | undefined,
    byUserId: string,
    reason: RoomStateReason,
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
      broadcastRoomState(
        room,
        request,
        userId,
        "playback",
        event.action,
        excludeSocket,
      );
    }
  };

  const enqueuePlaybackBurstEvent = (
    room: Room,
    request: RequestLike | undefined,
    userId: string,
    action: DedupablePlaybackAction,
    excludeSocket: WsConnection | undefined,
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
    excludeSocket?: WsConnection,
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

  const applyPlaybackAction = async (
    room: Room,
    action: PlaybackAction,
    atTimeSec?: number,
    videoId?: string,
    subtitleId?: string,
    subtitleUrl?: string,
    subtitleLabel?: string,
    subtitleLanguage?: string,
  ): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> => {
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
          subtitle: null,
        };
        changed = true;
      }
    }

    if (action === "changeSubtitle") {
      if (subtitleId && subtitleUrl?.trim()) {
        return { ok: false, error: "ambiguous_subtitle_source" };
      }

      const normalizedLabel = normalizeSubtitleLabel(subtitleLabel);
      const normalizedLanguage = normalizeSubtitleLanguage(subtitleLanguage);

      let nextSubtitle: SubtitleState | null = null;

      if (subtitleId) {
        const subtitle = await getSubtitleById(subtitleId);
        if (!subtitle) {
          return { ok: false, error: "subtitle_not_found" };
        }
        nextSubtitle = {
          source: "local",
          trackUrl: subtitle.trackPath,
          label: normalizedLabel ?? subtitle.fileName,
          language: normalizedLanguage,
        };
      } else if (subtitleUrl?.trim()) {
        const normalizedSubtitleUrl = normalizeExternalSubtitleUrl(subtitleUrl);
        if (!normalizedSubtitleUrl) {
          return { ok: false, error: "invalid_subtitle_url" };
        }
        nextSubtitle = {
          source: "link",
          trackUrl: normalizedSubtitleUrl,
          label: normalizedLabel ?? "External subtitle",
          language: normalizedLanguage,
        };
      }

      if (!isSameSubtitleState(playback.subtitle, nextSubtitle)) {
        room.playback = {
          ...playback,
          subtitle: nextSubtitle,
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

  return {
    rooms,
    chatByRoom,
    socketsByRoom,
    socketUserByConnection,
    recentPauseByRoomUser,
    dataDir,
    subtitlesDir,
    controlLeaseMs: CONTROL_LEASE_MS,
    seekPauseNoiseWindowMs: SEEK_PAUSE_NOISE_WINDOW_MS,
    maxSubtitleUploadBytes: MAX_SUBTITLE_UPLOAD_BYTES,
    nowMs,
    newId,
    toSubtitleId,
    trackPathForSubtitleId,
    contentTypeForVideo,
    subtitleFormatForFileName,
    parseSingleRange,
    getBaseUrl,
    playbackSummary,
    normalizeNickname,
    toSafeSubtitleFileName,
    getMemberProfile,
    getDisplayNameForUser,
    setNicknameForUser,
    normalizePlayback,
    getRoomOr404,
    listVideos,
    getVideoById,
    listSubtitles,
    getSubtitleById,
    readSubtitleAsVtt,
    roomResponse,
    sendWs,
    broadcastRoomState,
    sendRoomStateToSocket,
    roomUserDedupeKey,
    enqueuePlaybackBurstEvent,
    hasOpenSocketForUser,
    removeMemberFromRoom,
    applyPlaybackAction,
    acquireControlLease,
  };
};
