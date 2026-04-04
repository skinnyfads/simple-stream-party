import type {
  MemberProfile,
  PlaybackState,
  RequestLike,
  Room,
  RoomResponse,
  SubtitleState,
} from "./types.js";

export const playbackSummary = (playback: PlaybackState): string => {
  const minutes = (playback.playbackTimeSec / 60).toFixed(2);
  return `${playback.playbackTimeSec.toFixed(2)}s (${minutes}m)`;
};

export const normalizeNickname = (
  value: string | undefined,
): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 32);
};

export const normalizeSubtitleLabel = (
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

export const normalizeSubtitleLanguage = (
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

export const normalizeExternalSubtitleUrl = (
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

export const normalizeExternalHlsUrl = (
  value: string | undefined,
): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.pathname.toLowerCase().endsWith(".m3u8")) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

export const isSameSubtitleState = (
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

export const normalizePlayback = (
  playback: PlaybackState,
  nowMs: () => number,
): PlaybackState => {
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

export const getMemberProfile = (room: Room, userId: string): MemberProfile => {
  const existing = room.memberProfiles.get(userId);
  if (existing) {
    return existing;
  }
  const fallback = { userId, nickname: userId };
  room.memberProfiles.set(userId, fallback);
  return fallback;
};

export const getDisplayNameForUser = (room: Room, userId: string): string =>
  getMemberProfile(room, userId).nickname;

export const setNicknameForUser = (
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

export const buildRoomResponse = (
  room: Room,
  resolveBaseUrl: (request?: RequestLike) => string,
  request?: RequestLike,
): RoomResponse => {
  const baseUrl = resolveBaseUrl(request);
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
