const EXTERNAL_VIDEO_ID_PREFIX = "external-";

export const makeExternalVideoId = (opaqueId: string): string =>
  `${EXTERNAL_VIDEO_ID_PREFIX}${opaqueId}`;

export const isExternalVideoId = (videoId: string): boolean =>
  videoId.startsWith(EXTERNAL_VIDEO_ID_PREFIX);
