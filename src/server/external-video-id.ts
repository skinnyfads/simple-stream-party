const EXTERNAL_VIDEO_ID_PREFIX = "external-";
const LEGACY_EXTERNAL_VIDEO_ID_PREFIX = "external:";

export const makeExternalVideoId = (opaqueId: string): string =>
  `${EXTERNAL_VIDEO_ID_PREFIX}${opaqueId}`;

export const fromExternalVideoId = (videoId: string): string | null => {
  const encoded = videoId.startsWith(LEGACY_EXTERNAL_VIDEO_ID_PREFIX)
    ? videoId.slice(LEGACY_EXTERNAL_VIDEO_ID_PREFIX.length)
    : videoId.startsWith(EXTERNAL_VIDEO_ID_PREFIX)
      ? videoId.slice(EXTERNAL_VIDEO_ID_PREFIX.length)
      : null;
  if (!encoded) {
    return null;
  }

  // Legacy support: older builds stored the full external URL in base64url.
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = new URL(decoded);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
};

export const isExternalVideoId = (videoId: string): boolean =>
  videoId.startsWith(EXTERNAL_VIDEO_ID_PREFIX) ||
  videoId.startsWith(LEGACY_EXTERNAL_VIDEO_ID_PREFIX);
