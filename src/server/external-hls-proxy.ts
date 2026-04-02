import crypto from "node:crypto";
import net from "node:net";

type CachedResponse = {
  body: Buffer;
  contentType: string;
  cacheControl: string;
  expiresAtMs: number;
  sizeBytes: number;
};

type ProxyResponse = {
  body: Buffer;
  contentType: string;
  cacheControl: string;
};

type ExternalHlsProxyErrorCode =
  | "invalid_proxy_target"
  | "forbidden_proxy_target"
  | "upstream_request_failed";

type ExternalHlsProxyError = {
  code: ExternalHlsProxyErrorCode;
  statusCode: number;
};

export type ExternalHlsProxy = {
  buildProxyUrl: (videoId: string, targetUrl: string) => string;
  fetchAndRewritePlaylist: (
    videoId: string,
    playlistUrl: string,
  ) => Promise<ProxyResponse>;
  fetchBySignedTarget: (
    videoId: string,
    encodedTarget: string | undefined,
    signature: string | undefined,
  ) => Promise<ProxyResponse>;
};

const PLAYLIST_TTL_MS = 2_000;
const SEGMENT_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_ENTRY_BYTES = 16 * 1024 * 1024;

const isPlaylistContentType = (value: string): boolean =>
  /mpegurl|vnd\.apple\.mpegurl|x-mpegurl/i.test(value);

const isPrivateIpAddress = (host: string): boolean => {
  if (net.isIP(host) === 4) {
    const [a, b] = host.split(".").map((part) => Number(part));
    if (a === 10 || a === 127 || a === 0) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    return false;
  }

  if (net.isIP(host) === 6) {
    const lower = host.toLowerCase();
    if (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    ) {
      return true;
    }
  }

  return false;
};

const isForbiddenHostname = (hostname: string): boolean => {
  const lower = hostname.trim().toLowerCase();
  if (!lower) {
    return true;
  }
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return true;
  }
  if (lower.endsWith(".local")) {
    return true;
  }
  if (isPrivateIpAddress(lower)) {
    return true;
  }
  return false;
};

const parseAndValidateTargetUrl = (value: string): URL | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (isForbiddenHostname(parsed.hostname)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const toEncodedTarget = (targetUrl: string): string =>
  Buffer.from(targetUrl, "utf8").toString("base64url");

const fromEncodedTarget = (value: string): string | null => {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded || null;
  } catch {
    return null;
  }
};

export const createExternalHlsProxy = (): ExternalHlsProxy => {
  const signingSecret = crypto.randomBytes(32);
  const cacheByTargetUrl = new Map<string, CachedResponse>();
  let cacheTotalBytes = 0;

  const signTarget = (targetUrl: string): string =>
    crypto
      .createHmac("sha256", signingSecret)
      .update(targetUrl)
      .digest("base64url");

  const getCached = (targetUrl: string): CachedResponse | null => {
    const cached = cacheByTargetUrl.get(targetUrl);
    if (!cached) {
      return null;
    }
    if (Date.now() > cached.expiresAtMs) {
      cacheByTargetUrl.delete(targetUrl);
      cacheTotalBytes -= cached.sizeBytes;
      return null;
    }
    cacheByTargetUrl.delete(targetUrl);
    cacheByTargetUrl.set(targetUrl, cached);
    return cached;
  };

  const setCached = (
    targetUrl: string,
    response: ProxyResponse,
    ttlMs: number,
  ): void => {
    const sizeBytes = response.body.length;
    if (sizeBytes <= 0 || sizeBytes > MAX_CACHE_ENTRY_BYTES) {
      return;
    }

    const previous = cacheByTargetUrl.get(targetUrl);
    if (previous) {
      cacheByTargetUrl.delete(targetUrl);
      cacheTotalBytes -= previous.sizeBytes;
    }

    cacheByTargetUrl.set(targetUrl, {
      body: response.body,
      contentType: response.contentType,
      cacheControl: response.cacheControl,
      expiresAtMs: Date.now() + ttlMs,
      sizeBytes,
    });
    cacheTotalBytes += sizeBytes;

    while (
      cacheByTargetUrl.size > MAX_CACHE_ENTRIES ||
      cacheTotalBytes > MAX_CACHE_TOTAL_BYTES
    ) {
      const oldest = cacheByTargetUrl.entries().next().value as
        | [string, CachedResponse]
        | undefined;
      if (!oldest) {
        break;
      }
      cacheByTargetUrl.delete(oldest[0]);
      cacheTotalBytes -= oldest[1].sizeBytes;
    }
  };

  const buildProxyUrl = (videoId: string, targetUrl: string): string => {
    const encodedTarget = toEncodedTarget(targetUrl);
    const signature = signTarget(targetUrl);
    return `/videos/${encodeURIComponent(videoId)}/hls/proxy?t=${encodeURIComponent(
      encodedTarget,
    )}&s=${encodeURIComponent(signature)}`;
  };

  const rewritePlaylist = (
    playlistContent: string,
    playlistUrl: string,
    videoId: string,
  ): string => {
    const lines = playlistContent.replace(/\r\n?/g, "\n").split("\n");

    const toProxyUrl = (rawUri: string): string => {
      const trimmed = rawUri.trim();
      if (!trimmed) {
        return rawUri;
      }
      try {
        const resolved = new URL(trimmed, playlistUrl).toString();
        const validated = parseAndValidateTargetUrl(resolved);
        if (!validated) {
          return rawUri;
        }
        return buildProxyUrl(videoId, validated.toString());
      } catch {
        return rawUri;
      }
    };

    return lines
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return line;
        }

        if (trimmed.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (_full, uri: string) => {
            const rewritten = toProxyUrl(uri);
            return `URI="${rewritten}"`;
          });
        }

        return toProxyUrl(trimmed);
      })
      .join("\n");
  };

  const fetchTargetUrl = async (
    targetUrl: string,
    videoId: string,
  ): Promise<ProxyResponse> => {
    const validatedTarget = parseAndValidateTargetUrl(targetUrl);
    if (!validatedTarget) {
      throw {
        code: "forbidden_proxy_target",
        statusCode: 403,
      } satisfies ExternalHlsProxyError;
    }

    const cached = getCached(validatedTarget.toString());
    if (cached) {
      return {
        body: cached.body,
        contentType: cached.contentType,
        cacheControl: cached.cacheControl,
      };
    }

    let response: Response;
    try {
      response = await fetch(validatedTarget.toString(), {
        headers: {
          "user-agent": "simple-stream-party/1.0",
          accept: "*/*",
        },
        redirect: "follow",
      });
    } catch {
      throw {
        code: "upstream_request_failed",
        statusCode: 502,
      } satisfies ExternalHlsProxyError;
    }

    if (!response.ok) {
      throw {
        code: "upstream_request_failed",
        statusCode:
          response.status === 404
            ? 404
            : response.status >= 400 && response.status < 500
              ? 502
              : 502,
      } satisfies ExternalHlsProxyError;
    }

    const upstreamContentType = response.headers.get("content-type") ?? "";
    const rawBody = Buffer.from(await response.arrayBuffer());
    const isPlaylist =
      validatedTarget.pathname.toLowerCase().endsWith(".m3u8") ||
      isPlaylistContentType(upstreamContentType);

    let body = rawBody;
    let contentType = upstreamContentType || "application/octet-stream";
    let cacheControl = "public, max-age=60";
    let ttlMs = SEGMENT_TTL_MS;

    if (isPlaylist) {
      const rewritten = rewritePlaylist(
        rawBody.toString("utf8"),
        targetUrl,
        videoId,
      );
      body = Buffer.from(rewritten, "utf8");
      contentType = "application/vnd.apple.mpegurl";
      cacheControl = "no-cache";
      ttlMs = PLAYLIST_TTL_MS;
    }

    const proxiedResponse: ProxyResponse = {
      body,
      contentType,
      cacheControl,
    };
    setCached(validatedTarget.toString(), proxiedResponse, ttlMs);
    return proxiedResponse;
  };

  const fetchAndRewritePlaylist = async (
    videoId: string,
    playlistUrl: string,
  ): Promise<ProxyResponse> => fetchTargetUrl(playlistUrl, videoId);

  const fetchBySignedTarget = async (
    videoId: string,
    encodedTarget: string | undefined,
    signature: string | undefined,
  ): Promise<ProxyResponse> => {
    if (!encodedTarget || !signature) {
      throw {
        code: "invalid_proxy_target",
        statusCode: 400,
      } satisfies ExternalHlsProxyError;
    }

    const targetUrl = fromEncodedTarget(encodedTarget);
    if (!targetUrl) {
      throw {
        code: "invalid_proxy_target",
        statusCode: 400,
      } satisfies ExternalHlsProxyError;
    }

    const expected = signTarget(targetUrl);
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      throw {
        code: "forbidden_proxy_target",
        statusCode: 403,
      } satisfies ExternalHlsProxyError;
    }

    return fetchTargetUrl(targetUrl, videoId);
  };

  return {
    buildProxyUrl,
    fetchAndRewritePlaylist,
    fetchBySignedTarget,
  };
};
