import type {
  DedupablePlaybackAction,
  PlaybackBurstEvent,
} from "../playback-dedupe.js";
import { dedupePlaybackBurst } from "../playback-dedupe.js";
import { createPlaybackActionHandler } from "./room-playback-actions.js";
import {
  buildRoomResponse,
  getDisplayNameForUser as getDisplayNameForUserForRoom,
  getMemberProfile as getMemberProfileForRoom,
  normalizeNickname as normalizeNicknameValue,
  normalizePlayback as normalizePlaybackWithClock,
  playbackSummary,
  setNicknameForUser as setNicknameForUserForRoom,
} from "./room-playback-helpers.js";
import type {
  ChatMessage,
  MemberProfile,
  PlaybackActivity,
  PlaybackAction,
  PlaybackState,
  RequestLike,
  Room,
  RoomResponse,
  RoomStateReason,
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

export type RoomPlaybackState = {
  rooms: Map<string, Room>;
  chatByRoom: Map<string, ChatMessage[]>;
  playbackActivitiesByRoom: Map<string, PlaybackActivity[]>;
  socketsByRoom: Map<string, Set<WsConnection>>;
  socketUserByConnection: WeakMap<WsConnection, string>;
  recentPauseByRoomUser: Map<string, number>;
  controlLeaseMs: number;
  seekPauseNoiseWindowMs: number;
  playbackSummary: (playback: PlaybackState) => string;
  normalizeNickname: (value: string | undefined) => string | undefined;
  getMemberProfile: (room: Room, userId: string) => MemberProfile;
  getDisplayNameForUser: (room: Room, userId: string) => string;
  setNicknameForUser: (
    room: Room,
    userId: string,
    nickname: string,
  ) => "updated" | "unchanged" | "invalid";
  normalizePlayback: (playback: PlaybackState) => PlaybackState;
  getRoomOr404: (roomId: string) => Room | null;
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
    externalHlsUrl?: string,
    subtitleId?: string,
    subtitleUrl?: string,
    subtitleLabel?: string,
    subtitleLanguage?: string,
  ) => Promise<{ ok: true; changed: boolean } | { ok: false; error: string }>;
  acquireControlLease: (room: Room, userId: string) => boolean;
  appendPlaybackActivity: (
    room: Room,
    userId: string,
    action: PlaybackAction,
  ) => PlaybackActivity;
  listPlaybackActivities: (roomId: string) => PlaybackActivity[];
  resolveExternalHlsUrl: (videoId: string) => string | null;
};

type CreateRoomPlaybackStateArgs = {
  nowMs: () => number;
  newId: () => string;
  getVideoById: (videoId: string) => Promise<VideoItem | null>;
  getSubtitleById: (subtitleId: string) => Promise<{
    fileName: string;
    trackPath: string;
  } | null>;
  resolveBaseUrl: (request?: RequestLike) => string;
};

export const createRoomPlaybackState = (
  args: CreateRoomPlaybackStateArgs,
): RoomPlaybackState => {
  const rooms = new Map<string, Room>();
  const chatByRoom = new Map<string, ChatMessage[]>();
  const playbackActivitiesByRoom = new Map<string, PlaybackActivity[]>();
  const externalHlsUrlByVideoId = new Map<string, string>();
  const socketsByRoom = new Map<string, Set<WsConnection>>();
  const socketUserByConnection = new WeakMap<WsConnection, string>();
  const pendingPlaybackBurstsByRoomUser = new Map<
    string,
    PendingPlaybackBurst
  >();
  const recentPauseByRoomUser = new Map<string, number>();

  const SEEK_EPSILON_SEC = 1;
  const CONTROL_LEASE_MS = 2000;
  const PLAYBACK_SYNC_INTERVAL_MS = 2000;
  const PLAYBACK_DEDUPE_WINDOW_MS = 250;
  const SEEK_PAUSE_NOISE_WINDOW_MS = 500;
  const MAX_PLAYBACK_ACTIVITY_HISTORY = 200;

  const normalizeNickname = (value: string | undefined): string | undefined =>
    normalizeNicknameValue(value);

  const getMemberProfile = (room: Room, userId: string): MemberProfile =>
    getMemberProfileForRoom(room, userId);

  const getDisplayNameForUser = (room: Room, userId: string): string =>
    getDisplayNameForUserForRoom(room, userId);

  const setNicknameForUser = (
    room: Room,
    userId: string,
    nickname: string,
  ): "updated" | "unchanged" | "invalid" =>
    setNicknameForUserForRoom(room, userId, nickname);

  const normalizePlayback = (playback: PlaybackState): PlaybackState =>
    normalizePlaybackWithClock(playback, args.nowMs);

  const getRoomOr404 = (roomId: string): Room | null =>
    rooms.get(roomId) ?? null;

  const roomResponse = (room: Room, request?: RequestLike): RoomResponse =>
    buildRoomResponse(room, args.resolveBaseUrl, request);

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

  const applyPlaybackAction = createPlaybackActionHandler({
    nowMs: args.nowMs,
    newId: args.newId,
    seekEpsilonSec: SEEK_EPSILON_SEC,
    getVideoById: args.getVideoById,
    getSubtitleById: args.getSubtitleById,
    externalHlsUrlByVideoId,
  });

  const acquireControlLease = (room: Room, userId: string): boolean => {
    const currentMs = args.nowMs();

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

  const appendPlaybackActivity = (
    room: Room,
    userId: string,
    action: PlaybackAction,
  ): PlaybackActivity => {
    const activity: PlaybackActivity = {
      id: args.newId(),
      roomId: room.id,
      userId,
      userDisplayName: getDisplayNameForUser(room, userId),
      action,
      playbackTimeSec: room.playback.playbackTimeSec,
      isPlaying: room.playback.isPlaying,
      videoId: room.playback.videoId,
      createdAtMs: args.nowMs(),
      revision: room.revision,
    };

    const roomActivities = playbackActivitiesByRoom.get(room.id) ?? [];
    roomActivities.push(activity);
    if (roomActivities.length > MAX_PLAYBACK_ACTIVITY_HISTORY) {
      roomActivities.shift();
    }
    playbackActivitiesByRoom.set(room.id, roomActivities);
    return activity;
  };

  const listPlaybackActivities = (roomId: string): PlaybackActivity[] => [
    ...(playbackActivitiesByRoom.get(roomId) ?? []),
  ];

  const resolveExternalHlsUrl = (videoId: string): string | null =>
    externalHlsUrlByVideoId.get(videoId) ?? null;

  const periodicPlaybackSync = setInterval(() => {
    const currentMs = args.nowMs();
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
    playbackActivitiesByRoom,
    socketsByRoom,
    socketUserByConnection,
    recentPauseByRoomUser,
    controlLeaseMs: CONTROL_LEASE_MS,
    seekPauseNoiseWindowMs: SEEK_PAUSE_NOISE_WINDOW_MS,
    playbackSummary,
    normalizeNickname,
    getMemberProfile,
    getDisplayNameForUser,
    setNicknameForUser,
    normalizePlayback,
    getRoomOr404,
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
    appendPlaybackActivity,
    listPlaybackActivities,
    resolveExternalHlsUrl,
  };
};
