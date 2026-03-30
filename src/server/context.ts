import crypto from "node:crypto";
import type { DedupablePlaybackAction } from "../playback-dedupe.js";
import { createMediaHelpers } from "./media-helpers.js";
import { createRoomPlaybackState } from "./room-playback-state.js";
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
  VideoItem,
  WsConnection,
  WsServerMessage,
} from "./types.js";

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
  const nowMs = (): number => Date.now();
  const newId = (): string => crypto.randomUUID();

  const media = createMediaHelpers();
  const roomPlayback = createRoomPlaybackState({
    nowMs,
    getVideoById: media.getVideoById,
    getSubtitleById: media.getSubtitleById,
    resolveBaseUrl: (request?: RequestLike) =>
      request ? media.getBaseUrl(request) : media.getServerBaseUrl(),
  });

  return {
    rooms: roomPlayback.rooms,
    chatByRoom: roomPlayback.chatByRoom,
    socketsByRoom: roomPlayback.socketsByRoom,
    socketUserByConnection: roomPlayback.socketUserByConnection,
    recentPauseByRoomUser: roomPlayback.recentPauseByRoomUser,
    dataDir: media.dataDir,
    subtitlesDir: media.subtitlesDir,
    controlLeaseMs: roomPlayback.controlLeaseMs,
    seekPauseNoiseWindowMs: roomPlayback.seekPauseNoiseWindowMs,
    maxSubtitleUploadBytes: media.maxSubtitleUploadBytes,
    nowMs,
    newId,
    toSubtitleId: media.toSubtitleId,
    trackPathForSubtitleId: media.trackPathForSubtitleId,
    contentTypeForVideo: media.contentTypeForVideo,
    subtitleFormatForFileName: media.subtitleFormatForFileName,
    parseSingleRange: media.parseSingleRange,
    getBaseUrl: media.getBaseUrl,
    playbackSummary: roomPlayback.playbackSummary,
    normalizeNickname: roomPlayback.normalizeNickname,
    toSafeSubtitleFileName: media.toSafeSubtitleFileName,
    getMemberProfile: roomPlayback.getMemberProfile,
    getDisplayNameForUser: roomPlayback.getDisplayNameForUser,
    setNicknameForUser: roomPlayback.setNicknameForUser,
    normalizePlayback: roomPlayback.normalizePlayback,
    getRoomOr404: roomPlayback.getRoomOr404,
    listVideos: media.listVideos,
    getVideoById: media.getVideoById,
    listSubtitles: media.listSubtitles,
    getSubtitleById: media.getSubtitleById,
    readSubtitleAsVtt: media.readSubtitleAsVtt,
    roomResponse: roomPlayback.roomResponse,
    sendWs: roomPlayback.sendWs,
    broadcastRoomState: roomPlayback.broadcastRoomState,
    sendRoomStateToSocket: roomPlayback.sendRoomStateToSocket,
    roomUserDedupeKey: roomPlayback.roomUserDedupeKey,
    enqueuePlaybackBurstEvent: roomPlayback.enqueuePlaybackBurstEvent,
    hasOpenSocketForUser: roomPlayback.hasOpenSocketForUser,
    removeMemberFromRoom: roomPlayback.removeMemberFromRoom,
    applyPlaybackAction: roomPlayback.applyPlaybackAction,
    acquireControlLease: roomPlayback.acquireControlLease,
  };
};
