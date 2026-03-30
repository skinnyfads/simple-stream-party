import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "./context.js";
import type { Room, SubtitleItem } from "./types.js";

export const registerHttpRoutes = (
  app: FastifyInstance,
  context: ServerContext,
): void => {
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
        streamUrl: `${baseUrl}${video.streamPath}`,
      })),
    };
  });

  app.get<{
    Params: { videoId: string };
  }>("/videos/:videoId/stream", async (request, reply) => {
    const { videoId } = request.params;
    const video = await context.getVideoById(videoId);
    if (!video) {
      reply.code(404);
      return { error: "video_not_found" };
    }

    const fullPath = path.join(context.dataDir, video.fileName);
    const rangeHeader = request.headers.range;
    const contentType = context.contentTypeForVideo(video.fileName);

    if (!rangeHeader) {
      reply.header("Content-Type", contentType);
      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Length", video.sizeBytes.toString());
      return reply.send(fs.createReadStream(fullPath));
    }

    const range = context.parseSingleRange(rangeHeader, video.sizeBytes);
    if (!range) {
      reply.code(416);
      reply.header("Content-Range", `bytes */${video.sizeBytes}`);
      return { error: "invalid_range" };
    }

    const { start, end } = range;
    const chunkSize = end - start + 1;
    reply.code(206);
    reply.header("Content-Type", contentType);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Length", chunkSize.toString());
    reply.header("Content-Range", `bytes ${start}-${end}/${video.sizeBytes}`);
    return reply.send(fs.createReadStream(fullPath, { start, end }));
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
