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
