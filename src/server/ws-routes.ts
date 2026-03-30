import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "./context.js";
import type { WsClientMessage, WsRawData } from "./types.js";

type WsRouteRequestLike = {
  params?: { roomId?: string };
  query?: { userId?: string; inviteToken?: string; nickname?: string };
  url?: string;
  raw?: { url?: string };
};

const getRequestUrl = (request: WsRouteRequestLike): string =>
  request.url ?? request.raw?.url ?? "";

const getWsRoomId = (request: WsRouteRequestLike): string | null => {
  if (request.params?.roomId) {
    return request.params.roomId;
  }

  const match = /^\/rooms\/([^/]+)\/ws(?:\?|$)/.exec(getRequestUrl(request));
  if (!match?.[1]) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

const getWsQuery = (
  request: WsRouteRequestLike,
): {
  userId?: string;
  inviteToken?: string;
  nickname?: string;
} => {
  if (request.query) {
    return request.query;
  }

  const url = getRequestUrl(request);
  const rawQuery = url.includes("?") ? (url.split("?")[1] ?? "") : "";
  const params = new URLSearchParams(rawQuery);
  const userId = params.get("userId") ?? undefined;
  const inviteToken = params.get("inviteToken") ?? undefined;
  const nickname = params.get("nickname") ?? undefined;
  return { userId, inviteToken, nickname };
};

export const registerWsRoutes = (
  app: FastifyInstance,
  context: ServerContext,
): void => {
  app.register(async (wsApp) => {
    await wsApp.register(websocket, {
      options: {
        verifyClient: () => true,
      },
    });

    wsApp.get<{
      Params: { roomId: string };
      Querystring: {
        userId?: string;
        inviteToken?: string;
        nickname?: string;
      };
    }>("/rooms/:roomId/ws", { websocket: true }, (socket, request): void => {
      const roomId = getWsRoomId(request);
      const { userId, inviteToken, nickname } = getWsQuery(request);

      if (!roomId) {
        context.sendWs(socket, { type: "error", error: "room_not_found" });
        socket.close();
        return;
      }

      const room = context.getRoomOr404(roomId);

      if (!room) {
        context.sendWs(socket, { type: "error", error: "room_not_found" });
        socket.close();
        return;
      }

      if (!userId) {
        context.sendWs(socket, { type: "error", error: "missing_user_id" });
        socket.close();
        return;
      }

      if (inviteToken !== room.inviteToken) {
        context.sendWs(socket, {
          type: "error",
          error: "invalid_invite_token",
        });
        socket.close();
        return;
      }

      app.log.info(
        {
          event: "room_join",
          roomId: room.id,
          userId,
        },
        "User joined room",
      );

      room.members.add(userId);
      if (nickname) {
        const setResult = context.setNicknameForUser(room, userId, nickname);
        if (setResult === "invalid") {
          context.sendWs(socket, { type: "error", error: "invalid_nickname" });
          socket.close();
          return;
        }
      } else {
        context.getMemberProfile(room, userId);
      }
      room.playback = context.normalizePlayback(room.playback);
      room.revision += 1;

      const roomSockets = context.socketsByRoom.get(room.id) ?? new Set();
      roomSockets.add(socket);
      context.socketsByRoom.set(room.id, roomSockets);
      context.socketUserByConnection.set(socket, userId);

      context.sendWs(socket, {
        type: "welcome",
        room: context.roomResponse(room, request),
        messages: context.chatByRoom.get(room.id) ?? [],
      });
      context.broadcastRoomState(
        room,
        request,
        userId,
        "join",
        undefined,
        socket,
      );

      socket.on("message", async (raw: WsRawData): Promise<void> => {
        let payload: WsClientMessage;
        try {
          payload = JSON.parse(raw.toString()) as WsClientMessage;
        } catch {
          context.sendWs(socket, { type: "error", error: "invalid_json" });
          return;
        }

        if (payload.type === "ping") {
          context.sendWs(socket, {
            type: "pong",
            at: new Date().toISOString(),
          });
          return;
        }

        if (payload.type === "sync") {
          room.playback = context.normalizePlayback(room.playback);
          context.sendWs(socket, {
            type: "room_state",
            room: context.roomResponse(room, request),
            reason: "sync",
            byUserId: userId,
            byDisplayName: context.getDisplayNameForUser(room, userId),
          });
          return;
        }

        if (payload.type === "profile") {
          if (payload.action !== "setNickname") {
            context.sendWs(socket, {
              type: "error",
              error: "invalid_profile_action",
            });
            return;
          }

          const setResult = context.setNicknameForUser(
            room,
            userId,
            payload.nickname,
          );
          if (setResult === "invalid") {
            context.sendWs(socket, {
              type: "error",
              error: "invalid_nickname",
            });
            return;
          }
          if (setResult === "unchanged") {
            return;
          }

          room.revision += 1;
          context.broadcastRoomState(
            room,
            request,
            userId,
            "nickname_change",
            undefined,
            socket,
          );
          context.sendWs(socket, {
            type: "room_state",
            room: context.roomResponse(room, request),
            reason: "nickname_change",
            byUserId: userId,
            byDisplayName: context.getDisplayNameForUser(room, userId),
          });
          return;
        }

        if (payload.type === "playback") {
          const playbackBeforeAction = room.playback;
          const roomUserKey = context.roomUserDedupeKey(room.id, userId);

          if (!context.acquireControlLease(room, userId)) {
            app.log.info(
              {
                event: "playback_rejected_control_lease",
                roomId: room.id,
                userId,
                action: payload.action,
                activeControllerId: room.activeControllerId,
                activeControllerUntilMs: room.activeControllerUntilMs,
              },
              "Playback action rejected because control lease is held by another user",
            );
            return;
          }

          const result = await context.applyPlaybackAction(
            room,
            payload.action,
            payload.atTimeSec,
            payload.videoId,
            payload.subtitleId,
            payload.subtitleUrl,
            payload.subtitleLabel,
            payload.subtitleLanguage,
          );

          if (!result.ok) {
            app.log.warn(
              {
                event: "playback_rejected_invalid_action",
                roomId: room.id,
                userId,
                action: payload.action,
                atTimeSec: payload.atTimeSec,
                videoId: payload.videoId,
                subtitleId: payload.subtitleId,
                subtitleUrl: payload.subtitleUrl,
                error: result.error,
              },
              "Playback action rejected",
            );
            context.sendWs(socket, { type: "error", error: result.error });
            return;
          }

          if (!result.changed) {
            app.log.info(
              {
                event: "playback_ignored_no_change",
                roomId: room.id,
                userId,
                action: payload.action,
                atTimeSec: payload.atTimeSec,
                videoId: payload.videoId,
                subtitleId: payload.subtitleId,
                subtitleUrl: payload.subtitleUrl,
                playbackTime: context.playbackSummary(room.playback),
              },
              "Playback action ignored because state is unchanged",
            );
            return;
          }

          if (
            payload.action === "play" ||
            payload.action === "pause" ||
            payload.action === "seek"
          ) {
            if (payload.action === "pause" && playbackBeforeAction.isPlaying) {
              context.recentPauseByRoomUser.set(roomUserKey, context.nowMs());
            } else if (payload.action !== "seek") {
              context.recentPauseByRoomUser.delete(roomUserKey);
            }

            if (payload.action === "seek" && !room.playback.isPlaying) {
              const pausedAtMs = context.recentPauseByRoomUser.get(roomUserKey);
              if (
                typeof pausedAtMs === "number" &&
                context.nowMs() - pausedAtMs <= context.seekPauseNoiseWindowMs
              ) {
                room.playback = {
                  ...room.playback,
                  isPlaying: true,
                  lastUpdatedAtMs: context.nowMs(),
                };
                room.revision += 1;
              }
              context.recentPauseByRoomUser.delete(roomUserKey);
            }
          } else {
            context.recentPauseByRoomUser.delete(roomUserKey);
          }

          app.log.info(
            {
              event: "playback_action_applied",
              roomId: room.id,
              userId,
              action: payload.action,
              atTimeSec: payload.atTimeSec,
              atMinute:
                typeof payload.atTimeSec === "number"
                  ? Number((payload.atTimeSec / 60).toFixed(2))
                  : undefined,
              videoId: payload.videoId ?? room.playback.videoId,
              subtitleId: payload.subtitleId,
              subtitleUrl:
                payload.subtitleUrl ?? room.playback.subtitle?.trackUrl,
              playbackTime: context.playbackSummary(room.playback),
              isPlaying: room.playback.isPlaying,
              revision: room.revision,
            },
            "Playback action applied",
          );

          if (payload.action === "changeVideo") {
            context.sendRoomStateToSocket(
              socket,
              room,
              request,
              userId,
              "video_change",
              payload.action,
            );
            context.broadcastRoomState(
              room,
              request,
              userId,
              "video_change",
              payload.action,
              socket,
            );
            return;
          }

          if (payload.action === "changeSubtitle") {
            context.sendRoomStateToSocket(
              socket,
              room,
              request,
              userId,
              "subtitle_change",
              payload.action,
            );
            context.broadcastRoomState(
              room,
              request,
              userId,
              "subtitle_change",
              payload.action,
              socket,
            );
            return;
          }

          context.sendRoomStateToSocket(
            socket,
            room,
            request,
            userId,
            "playback",
            payload.action,
          );
          context.enqueuePlaybackBurstEvent(
            room,
            request,
            userId,
            payload.action,
            socket,
          );
          return;
        }

        if (payload.type === "chat") {
          const trimmed = payload.message.trim();
          if (!trimmed) {
            context.sendWs(socket, { type: "error", error: "message_empty" });
            return;
          }

          const rawReplyToMessageId = payload.replyToMessageId;
          const replyToMessageId =
            typeof rawReplyToMessageId === "string"
              ? rawReplyToMessageId.trim()
              : undefined;

          if (replyToMessageId === "") {
            context.sendWs(socket, {
              type: "error",
              error: "invalid_reply_message_id",
            });
            return;
          }

          const roomMessages = context.chatByRoom.get(room.id) ?? [];
          if (
            replyToMessageId &&
            !roomMessages.some((message) => message.id === replyToMessageId)
          ) {
            context.sendWs(socket, {
              type: "error",
              error: "reply_message_not_found",
            });
            return;
          }

          const newMessage = {
            id: context.newId(),
            roomId: room.id,
            userId,
            userDisplayName: context.getDisplayNameForUser(room, userId),
            message: trimmed,
            createdAtMs: context.nowMs(),
            ...(replyToMessageId ? { replyToMessageId } : {}),
          };

          roomMessages.push(newMessage);
          if (roomMessages.length > 200) {
            roomMessages.shift();
          }
          context.chatByRoom.set(room.id, roomMessages);
          room.revision += 1;

          const roomSocketsForChat = context.socketsByRoom.get(room.id);
          if (!roomSocketsForChat) {
            return;
          }

          for (const ws of roomSocketsForChat) {
            context.sendWs(ws, {
              type: "chat_message",
              message: newMessage,
              revision: room.revision,
            });
          }
        }
      });

      socket.on("close", () => {
        app.log.info(
          {
            event: "room_leave",
            roomId: room.id,
            userId,
          },
          "User left room",
        );

        const roomSocketSet = context.socketsByRoom.get(room.id);
        if (!roomSocketSet) {
          return;
        }

        roomSocketSet.delete(socket);
        if (roomSocketSet.size === 0) {
          context.socketsByRoom.delete(room.id);
        }

        if (context.hasOpenSocketForUser(room.id, userId, socket)) {
          return;
        }

        const displayNameBeforeLeave = context.getDisplayNameForUser(
          room,
          userId,
        );
        const didLeave = context.removeMemberFromRoom(room, userId);
        if (didLeave) {
          context.broadcastRoomState(
            room,
            request,
            userId,
            "leave",
            undefined,
            undefined,
            displayNameBeforeLeave,
          );
        }
      });
    });
  });
};
