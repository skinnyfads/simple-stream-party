import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "./context.js";
import { fromExternalVideoId, isExternalVideoId } from "./external-video-id.js";
import { createExternalHlsProxy } from "./external-hls-proxy.js";
import type { Room, SubtitleItem } from "./types.js";

export const registerHttpRoutes = (
  app: FastifyInstance,
  context: ServerContext,
): void => {
  const externalHlsProxy = createExternalHlsProxy();

  app.get("/health", async () => ({
    ok: true,
    service: "simple-stream-party",
    at: new Date().toISOString(),
  }));

  app.get("/videos", async (request) => {
    const videos = await context.listVideos();
    const baseUrl = context.getBaseUrl(request);
    return {
      dataDir: context.dataDir,
      count: videos.length,
      videos: videos.map((video) => ({
        id: video.id,
        fileName: video.fileName,
        sizeBytes: video.sizeBytes,
        modifiedAtMs: video.modifiedAtMs,
        hlsUrl: `${baseUrl}/videos/${video.id}/hls/playlist.m3u8`,
        hlsStatus: context.hlsTranscoder.getStatus(video.id),
      })),
    };
  });

  app.get<{
    Params: { videoId: string };
  }>("/videos/:videoId/hls/status", async (request, reply) => {
    const { videoId } = request.params;
    const externalPlaylistUrl = isExternalVideoId(videoId)
      ? (context.resolveExternalHlsUrl(videoId) ?? fromExternalVideoId(videoId))
      : null;
    if (externalPlaylistUrl) {
      return {
        videoId,
        status: "ready",
      };
    }

    const video = await context.getVideoById(videoId);
    if (!video) {
      reply.code(404);
      return { error: "video_not_found" };
    }

    return {
      videoId,
      status: context.hlsTranscoder.getStatus(videoId),
    };
  });

  app.get<{
    Params: { videoId: string };
    Querystring: { t?: string; s?: string };
  }>("/videos/:videoId/hls/proxy", async (request, reply) => {
    const { videoId } = request.params;
    const { t, s } = request.query;

    if (!isExternalVideoId(videoId)) {
      reply.code(404);
      return { error: "video_not_found" };
    }

    if (
      !context.resolveExternalHlsUrl(videoId) &&
      !fromExternalVideoId(videoId)
    ) {
      reply.code(404);
      return { error: "video_not_found" };
    }

    try {
      const proxied = await externalHlsProxy.fetchBySignedTarget(videoId, t, s);
      reply.header("Content-Type", proxied.contentType);
      reply.header("Content-Length", proxied.body.length.toString());
      reply.header("Cache-Control", proxied.cacheControl);
      return reply.send(proxied.body);
    } catch (error) {
      const err = error as { code?: string; statusCode?: number };
      reply.code(err.statusCode ?? 502);
      return { error: err.code ?? "upstream_request_failed" };
    }
  });

  app.get<{
    Params: { videoId: string; "*": string };
  }>("/videos/:videoId/hls/*", async (request, reply) => {
    const { videoId } = request.params;
    const hlsFile = request.params["*"];

    if (!hlsFile) {
      reply.code(400);
      return { error: "missing_hls_file" };
    }

    const externalPlaylistUrl =
      context.resolveExternalHlsUrl(videoId) ?? fromExternalVideoId(videoId);
    if (externalPlaylistUrl) {
      if (hlsFile !== "playlist.m3u8") {
        reply.code(404);
        return { error: "file_not_found" };
      }

      try {
        const proxied = await externalHlsProxy.fetchAndRewritePlaylist(
          videoId,
          externalPlaylistUrl,
        );
        reply.header("Content-Type", proxied.contentType);
        reply.header("Content-Length", proxied.body.length.toString());
        reply.header("Cache-Control", proxied.cacheControl);
        return reply.send(proxied.body);
      } catch (error) {
        const err = error as { code?: string; statusCode?: number };
        reply.code(err.statusCode ?? 502);
        return { error: err.code ?? "upstream_request_failed" };
      }
    }

    // Security: only allow .m3u8 and .ts files, no path traversal
    const safeName = path.basename(hlsFile);
    const ext = path.extname(safeName).toLowerCase();
    if (ext !== ".m3u8" && ext !== ".ts") {
      reply.code(400);
      return { error: "invalid_hls_file_type" };
    }

    if (!context.hlsTranscoder.isReady(videoId)) {
      reply.code(404);
      return { error: "hls_not_ready" };
    }

    const hlsDir = context.hlsTranscoder.getHlsDir(videoId);
    const fullPath = path.join(hlsDir, safeName);
    const normalized = path.normalize(fullPath);
    if (!normalized.startsWith(hlsDir + path.sep) && normalized !== hlsDir) {
      reply.code(400);
      return { error: "invalid_path" };
    }

    try {
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) {
        reply.code(404);
        return { error: "file_not_found" };
      }

      const contentType =
        ext === ".m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t";

      reply.header("Content-Type", contentType);
      reply.header("Content-Length", stat.size.toString());

      if (ext === ".ts") {
        // Segments are immutable, cache aggressively
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        // Playlist should not be cached
        reply.header("Cache-Control", "no-cache");
      }

      return reply.send(fs.createReadStream(fullPath));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        reply.code(404);
        return { error: "file_not_found" };
      }
      throw error;
    }
  });

  app.get("/subtitles", async (request) => {
    const subtitles = await context.listSubtitles();
    const baseUrl = context.getBaseUrl(request);
    return {
      dataDir: context.subtitlesDir,
      count: subtitles.length,
      subtitles: subtitles.map((subtitle) => ({
        id: subtitle.id,
        fileName: subtitle.fileName,
        sizeBytes: subtitle.sizeBytes,
        modifiedAtMs: subtitle.modifiedAtMs,
        format: subtitle.format,
        trackUrl: `${baseUrl}${subtitle.trackPath}`,
      })),
    };
  });

  app.get<{
    Params: { subtitleId: string };
  }>("/subtitles/:subtitleId/track", async (request, reply) => {
    const { subtitleId } = request.params;
    const subtitle = await context.getSubtitleById(subtitleId);
    if (!subtitle) {
      reply.code(404);
      return { error: "subtitle_not_found" };
    }

    const vttTrack = await context.readSubtitleAsVtt(subtitle);
    reply.header("Content-Type", "text/vtt; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    return reply.send(vttTrack);
  });

  app.post<{
    Body: {
      fileName: string;
      contentBase64: string;
    };
  }>("/subtitles/upload", async (request, reply) => {
    const safeFileName = context.toSafeSubtitleFileName(request.body.fileName);
    if (!safeFileName) {
      reply.code(400);
      return { error: "invalid_subtitle_file_name" };
    }

    const format = context.subtitleFormatForFileName(safeFileName);
    if (!format) {
      reply.code(400);
      return { error: "unsupported_subtitle_format" };
    }

    const rawBase64 = request.body.contentBase64?.trim();
    if (!rawBase64) {
      reply.code(400);
      return { error: "missing_subtitle_content" };
    }

    let subtitleContent: Buffer;
    try {
      subtitleContent = Buffer.from(rawBase64, "base64");
    } catch {
      reply.code(400);
      return { error: "invalid_subtitle_content" };
    }

    if (subtitleContent.length === 0) {
      reply.code(400);
      return { error: "invalid_subtitle_content" };
    }

    if (subtitleContent.length > context.maxSubtitleUploadBytes) {
      reply.code(413);
      return { error: "subtitle_too_large" };
    }

    const storedFileName = `${Date.now()}-${context.newId()}-${safeFileName}`;
    const fullPath = path.join(context.subtitlesDir, storedFileName);
    await fsp.mkdir(context.subtitlesDir, { recursive: true });
    await fsp.writeFile(fullPath, subtitleContent);

    const stat = await fsp.stat(fullPath);
    const subtitleId = context.toSubtitleId(storedFileName);
    const subtitle: SubtitleItem = {
      id: subtitleId,
      fileName: storedFileName,
      sizeBytes: stat.size,
      modifiedAtMs: stat.mtimeMs,
      trackPath: context.trackPathForSubtitleId(subtitleId),
      format,
    };
    const baseUrl = context.getBaseUrl(request);

    reply.code(201);
    return {
      subtitle: {
        id: subtitle.id,
        fileName: subtitle.fileName,
        sizeBytes: subtitle.sizeBytes,
        modifiedAtMs: subtitle.modifiedAtMs,
        format: subtitle.format,
        trackUrl: `${baseUrl}${subtitle.trackPath}`,
      },
    };
  });

  app.post<{
    Body: {
      creatorId: string;
      videoId: string;
      creatorNickname?: string;
    };
  }>("/rooms/from-video", async (request, reply) => {
    const { creatorId, videoId, creatorNickname } = request.body;
    const video = await context.getVideoById(videoId);
    if (!video) {
      reply.code(404);
      return { error: "video_not_found" };
    }

    const now = context.nowMs();
    const room: Room = {
      id: context.newId(),
      creatorId,
      inviteToken: context.newId(),
      members: new Set([creatorId]),
      memberProfiles: new Map([
        [
          creatorId,
          {
            userId: creatorId,
            nickname: context.normalizeNickname(creatorNickname) ?? creatorId,
          },
        ],
      ]),
      playback: {
        videoId: video.id,
        videoUrl: video.streamPath,
        hlsUrl: `/videos/${video.id}/hls/playlist.m3u8`,
        playbackTimeSec: 0,
        isPlaying: false,
        lastUpdatedAtMs: now,
        subtitle: null,
      },
      createdAtMs: now,
      revision: 1,
      activeControllerId: creatorId,
      activeControllerUntilMs: now + context.controlLeaseMs,
    };

    context.rooms.set(room.id, room);
    context.chatByRoom.set(room.id, []);
    context.playbackActivitiesByRoom.set(room.id, []);

    reply.code(201);
    return context.roomResponse(room, request);
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

    const room = context.getRoomOr404(roomId);
    if (!room) {
      reply.code(404);
      return { error: "room_not_found" };
    }

    if (inviteToken !== room.inviteToken) {
      reply.code(403);
      return { error: "invalid_invite_token" };
    }

    const displayNameBeforeLeave = context.getDisplayNameForUser(
      room,
      trimmedUserId,
    );
    const didLeave = context.removeMemberFromRoom(room, trimmedUserId);
    if (didLeave) {
      context.broadcastRoomState(
        room,
        request,
        trimmedUserId,
        "leave",
        undefined,
        undefined,
        displayNameBeforeLeave,
      );
    }

    const roomSockets = context.socketsByRoom.get(room.id);
    if (roomSockets) {
      for (const socket of roomSockets) {
        if (context.socketUserByConnection.get(socket) === trimmedUserId) {
          socket.close(1000, "left_room");
        }
      }
    }

    return {
      left: didLeave,
      room: context.roomResponse(room, request),
    };
  });
};
