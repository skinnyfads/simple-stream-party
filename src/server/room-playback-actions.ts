import { isExternalVideoId, makeExternalVideoId } from "./external-video-id.js";
import {
  isSameSubtitleState,
  normalizeExternalHlsUrl,
  normalizeExternalSubtitleUrl,
  normalizePlayback,
  normalizeSubtitleLabel,
  normalizeSubtitleLanguage,
} from "./room-playback-helpers.js";
import type {
  PlaybackAction,
  Room,
  SubtitleState,
  VideoItem,
} from "./types.js";

type PlaybackActionResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: string };

type CreatePlaybackActionHandlerArgs = {
  nowMs: () => number;
  newId: () => string;
  seekEpsilonSec: number;
  getVideoById: (videoId: string) => Promise<VideoItem | null>;
  getSubtitleById: (subtitleId: string) => Promise<{
    fileName: string;
    trackPath: string;
  } | null>;
  externalHlsUrlByVideoId: Map<string, string>;
};

export const createPlaybackActionHandler = (
  args: CreatePlaybackActionHandlerArgs,
) => {
  return async (
    room: Room,
    action: PlaybackAction,
    atTimeSec?: number,
    videoId?: string,
    externalHlsUrl?: string,
    subtitleId?: string,
    subtitleUrl?: string,
    subtitleLabel?: string,
    subtitleLanguage?: string,
  ): Promise<PlaybackActionResult> => {
    const playback = normalizePlayback(room.playback, args.nowMs);
    const currentMs = args.nowMs();
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
      if (Math.abs(playback.playbackTimeSec - atTimeSec) > args.seekEpsilonSec) {
        room.playback = {
          ...playback,
          playbackTimeSec: atTimeSec,
          lastUpdatedAtMs: currentMs,
        };
        changed = true;
      }
    }

    if (action === "changeVideo") {
      if (videoId && externalHlsUrl?.trim()) {
        return { ok: false, error: "ambiguous_video_source" };
      }

      if (!videoId && !externalHlsUrl?.trim()) {
        return { ok: false, error: "missing_video_id" };
      }

      if (videoId) {
        const video = await args.getVideoById(videoId);
        if (!video) {
          return { ok: false, error: "video_not_found" };
        }

        if (playback.videoId !== video.id) {
          room.playback = {
            videoId: video.id,
            videoUrl: video.streamPath,
            hlsUrl: `/videos/${video.id}/hls/playlist.m3u8`,
            hlsStatus: undefined,
            playbackTimeSec: 0,
            isPlaying: false,
            lastUpdatedAtMs: currentMs,
            subtitle: null,
          };
          changed = true;
        }
      } else {
        const normalizedExternalHlsUrl =
          normalizeExternalHlsUrl(externalHlsUrl);
        if (!normalizedExternalHlsUrl) {
          return { ok: false, error: "invalid_external_hls_url" };
        }

        const currentExternalHlsUrl = isExternalVideoId(playback.videoId)
          ? args.externalHlsUrlByVideoId.get(playback.videoId)
          : undefined;

        let externalVideoId: string | undefined;
        for (const [videoIdCandidate, mappedUrl] of args.externalHlsUrlByVideoId) {
          if (mappedUrl === normalizedExternalHlsUrl) {
            externalVideoId = videoIdCandidate;
            break;
          }
        }
        if (!externalVideoId) {
          externalVideoId = makeExternalVideoId(args.newId());
        }
        args.externalHlsUrlByVideoId.set(externalVideoId, normalizedExternalHlsUrl);

        if (
          playback.videoId !== externalVideoId ||
          currentExternalHlsUrl !== normalizedExternalHlsUrl ||
          playback.hlsUrl !==
            `/videos/${encodeURIComponent(externalVideoId)}/hls/playlist.m3u8`
        ) {
          room.playback = {
            videoId: externalVideoId,
            videoUrl: undefined,
            hlsUrl: `/videos/${encodeURIComponent(externalVideoId)}/hls/playlist.m3u8`,
            hlsStatus: "ready",
            playbackTimeSec: 0,
            isPlaying: false,
            lastUpdatedAtMs: currentMs,
            subtitle: null,
          };
          changed = true;
        }
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
        const subtitle = await args.getSubtitleById(subtitleId);
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
};
