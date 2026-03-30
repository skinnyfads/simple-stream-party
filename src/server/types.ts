import type { RawData, WebSocket } from "ws";

export type PlaybackAction =
  | "play"
  | "pause"
  | "seek"
  | "changeVideo"
  | "changeSubtitle";

export type SubtitleSource = "local" | "link";

export type SubtitleState = {
  source: SubtitleSource;
  trackUrl: string;
  label: string;
  language?: string;
};

export type PlaybackState = {
  videoId: string;
  videoUrl: string;
  playbackTimeSec: number;
  isPlaying: boolean;
  lastUpdatedAtMs: number;
  subtitle: SubtitleState | null;
};

export type MemberProfile = {
  userId: string;
  nickname: string;
};

export type Room = {
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

export type ChatMessage = {
  id: string;
  roomId: string;
  userId: string;
  userDisplayName?: string;
  message: string;
  createdAtMs: number;
  replyToMessageId?: string;
};

export type VideoItem = {
  id: string;
  fileName: string;
  sizeBytes: number;
  modifiedAtMs: number;
  streamPath: string;
};

export type SubtitleFormat = "vtt" | "srt";

export type SubtitleItem = {
  id: string;
  fileName: string;
  sizeBytes: number;
  modifiedAtMs: number;
  trackPath: string;
  format: SubtitleFormat;
};

export type RequestLike = {
  protocol: string;
  hostname: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
};

export type WsClientMessage =
  | {
      type: "playback";
      action: PlaybackAction;
      atTimeSec?: number;
      videoId?: string;
      subtitleId?: string;
      subtitleUrl?: string;
      subtitleLabel?: string;
      subtitleLanguage?: string;
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

export type RoomStateReason =
  | "join"
  | "leave"
  | "playback"
  | "video_change"
  | "subtitle_change"
  | "sync"
  | "nickname_change";

export type RoomResponse = {
  roomId: string;
  creatorId: string;
  inviteToken: string;
  shareUrl: string;
  memberCount: number;
  members: MemberProfile[];
  revision: number;
  playback: PlaybackState;
};

export type WsServerMessage =
  | {
      type: "welcome";
      room: RoomResponse;
      messages: ChatMessage[];
    }
  | {
      type: "room_state";
      room: RoomResponse;
      reason: RoomStateReason;
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

export type WsConnection = WebSocket;
export type WsRawData = RawData;
