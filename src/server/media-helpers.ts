import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import env from "../env.js";
import type {
  RequestLike,
  SubtitleFormat,
  SubtitleItem,
  VideoItem,
} from "./types.js";

export type MediaHelpers = {
  dataDir: string;
  subtitlesDir: string;
  maxSubtitleUploadBytes: number;
  toSubtitleId: (fileName: string) => string;
  trackPathForSubtitleId: (subtitleId: string) => string;
  contentTypeForVideo: (fileName: string) => string;
  subtitleFormatForFileName: (fileName: string) => SubtitleFormat | null;
  parseSingleRange: (
    rangeHeader: string,
    sizeBytes: number,
  ) => { start: number; end: number } | null;
  getBaseUrl: (request: RequestLike) => string;
  getServerBaseUrl: () => string;
  toSafeSubtitleFileName: (value: string) => string | null;
  listVideos: () => Promise<VideoItem[]>;
  getVideoById: (videoId: string) => Promise<VideoItem | null>;
  listSubtitles: () => Promise<SubtitleItem[]>;
  getSubtitleById: (subtitleId: string) => Promise<SubtitleItem | null>;
  readSubtitleAsVtt: (subtitle: SubtitleItem) => Promise<string>;
};

export const createMediaHelpers = (): MediaHelpers => {
  const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v"]);
  const SUBTITLE_EXTENSIONS = new Set([".vtt", ".srt"]);
  const dataDir = path.resolve(process.cwd(), env.DATA_DIR);
  const subtitlesDir = path.join(dataDir, "subtitles");
  const maxSubtitleUploadBytes = 2 * 1024 * 1024;

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

  const toSafeSubtitleFileName = (value: string): string | null => {
    const base = path.basename(value).trim();
    if (!base) {
      return null;
    }
    const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
    return sanitized || null;
  };

  const hlsBaseDir = path.join(dataDir, "hls");

  /**
   * Discover videos from HLS directories (originals may have been deleted).
   * Each HLS directory name is a videoId, which decodes to the original fileName.
   */
  const listHlsOnlyVideos = async (
    excludeIds: Set<string>,
  ): Promise<VideoItem[]> => {
    let hlsEntries: fs.Dirent[];
    try {
      hlsEntries = await fsp.readdir(hlsBaseDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const videos: VideoItem[] = [];
    for (const entry of hlsEntries) {
      if (!entry.isDirectory() || excludeIds.has(entry.name)) {
        continue;
      }

      const videoId = entry.name;
      const originalFileName = fromVideoId(videoId);
      if (!originalFileName) {
        continue;
      }

      // Check playlist exists
      const playlistPath = path.join(hlsBaseDir, videoId, "playlist.m3u8");
      try {
        const stat = await fsp.stat(playlistPath);
        if (!stat.isFile()) {
          continue;
        }

        videos.push({
          id: videoId,
          fileName: originalFileName,
          sizeBytes: 0,
          modifiedAtMs: stat.mtimeMs,
          streamPath: streamPathForVideoId(videoId),
        });
      } catch {
        continue;
      }
    }
    return videos;
  };

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
    const sourceVideoIds = new Set<string>();

    for (const file of files) {
      const ext = path.extname(file.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) {
        continue;
      }

      const fullPath = path.join(dataDir, file.name);
      const stat = await fsp.stat(fullPath);
      const id = toVideoId(file.name);
      sourceVideoIds.add(id);

      videos.push({
        id,
        fileName: file.name,
        sizeBytes: stat.size,
        modifiedAtMs: stat.mtimeMs,
        streamPath: streamPathForVideoId(id),
      });
    }

    // Also discover videos that only exist as HLS (original deleted)
    const hlsOnlyVideos = await listHlsOnlyVideos(sourceVideoIds);
    videos.push(...hlsOnlyVideos);

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

    // Try source file first
    try {
      const stat = await fsp.stat(fullPath);
      if (stat.isFile()) {
        return {
          id: videoId,
          fileName,
          sizeBytes: stat.size,
          modifiedAtMs: stat.mtimeMs,
          streamPath: streamPathForVideoId(videoId),
        };
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    // Source file gone — check if HLS directory exists
    const playlistPath = path.join(hlsBaseDir, videoId, "playlist.m3u8");
    try {
      const stat = await fsp.stat(playlistPath);
      if (stat.isFile()) {
        return {
          id: videoId,
          fileName,
          sizeBytes: 0,
          modifiedAtMs: stat.mtimeMs,
          streamPath: streamPathForVideoId(videoId),
        };
      }
    } catch {
      // No HLS either
    }

    return null;
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

  return {
    dataDir,
    subtitlesDir,
    maxSubtitleUploadBytes,
    toSubtitleId,
    trackPathForSubtitleId,
    contentTypeForVideo,
    subtitleFormatForFileName,
    parseSingleRange,
    getBaseUrl,
    getServerBaseUrl,
    toSafeSubtitleFileName,
    listVideos,
    getVideoById,
    listSubtitles,
    getSubtitleById,
    readSubtitleAsVtt,
  };
};
