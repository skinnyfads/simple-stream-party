import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import env from "../env.js";

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
  | "upstream_request_failed"
  | "upstream_response_too_large"
  | "proxy_overloaded";

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
const MAX_REDIRECT_HOPS = 3;
const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_UPSTREAM_FETCHES = 16;
const MAX_UPSTREAM_PLAYLIST_BYTES = 1 * 1024 * 1024;
const MAX_UPSTREAM_SEGMENT_BYTES = MAX_CACHE_ENTRY_BYTES;

const isPlaylistContentType = (value: string): boolean =>
  /mpegurl|vnd\.apple\.mpegurl|x-mpegurl/i.test(value);

type AllowedHostRule =
  | { kind: "exact"; host: string }
  | { kind: "subdomain"; suffix: string };

const FORBIDDEN_IP_BLOCKLIST = new net.BlockList();
FORBIDDEN_IP_BLOCKLIST.addSubnet("0.0.0.0", 8, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("10.0.0.0", 8, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("100.64.0.0", 10, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("127.0.0.0", 8, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("169.254.0.0", 16, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("172.16.0.0", 12, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("192.0.0.0", 24, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("192.0.2.0", 24, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("192.168.0.0", 16, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("198.18.0.0", 15, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("198.51.100.0", 24, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("203.0.113.0", 24, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("224.0.0.0", 4, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addSubnet("240.0.0.0", 4, "ipv4");
FORBIDDEN_IP_BLOCKLIST.addAddress("255.255.255.255", "ipv4");

FORBIDDEN_IP_BLOCKLIST.addAddress("::", "ipv6");
FORBIDDEN_IP_BLOCKLIST.addAddress("::1", "ipv6");
FORBIDDEN_IP_BLOCKLIST.addSubnet("fc00::", 7, "ipv6");
FORBIDDEN_IP_BLOCKLIST.addSubnet("fe80::", 10, "ipv6");
FORBIDDEN_IP_BLOCKLIST.addSubnet("ff00::", 8, "ipv6");
FORBIDDEN_IP_BLOCKLIST.addSubnet("2001:db8::", 32, "ipv6");

const normalizeHostname = (hostname: string): string =>
  hostname.trim().toLowerCase().replace(/\.+$/, "");

const parseAllowedHostRules = (value: string): AllowedHostRule[] =>
  value
    .split(",")
    .map((host) => normalizeHostname(host))
    .filter((host) => host.length > 0)
    .map((host) => {
      if (host.startsWith("*.")) {
        const suffix = host.slice(1);
        if (suffix.length > 1) {
          return { kind: "subdomain", suffix } satisfies AllowedHostRule;
        }
      }
      return { kind: "exact", host } satisfies AllowedHostRule;
    });

const allowedHostRules = parseAllowedHostRules(env.EXTERNAL_HLS_ALLOWED_HOSTS);

const isForbiddenIpAddress = (host: string): boolean => {
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    return FORBIDDEN_IP_BLOCKLIST.check(host, "ipv4");
  }
  if (ipVersion === 6) {
    return FORBIDDEN_IP_BLOCKLIST.check(host, "ipv6");
  }
  return false;
};

const isAllowedHostname = (hostname: string): boolean => {
  if (allowedHostRules.length === 0) {
    return false;
  }

  return allowedHostRules.some((rule) => {
    if (rule.kind === "exact") {
      return hostname === rule.host;
    }
    return hostname.endsWith(rule.suffix) && hostname.length > rule.suffix.length;
  });
};

const resolvesToOnlyPublicIps = async (hostname: string): Promise<boolean> => {
  const ipVersion = net.isIP(hostname);
  if (ipVersion > 0) {
    return !isForbiddenIpAddress(hostname);
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      return false;
    }

    return records.every((record) => !isForbiddenIpAddress(record.address));
  } catch {
    return false;
  }
};

const isForbiddenHostname = (hostname: string): boolean => {
  const lower = normalizeHostname(hostname);
  if (!lower) {
    return true;
  }
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return true;
  }
  if (lower.endsWith(".local")) {
    return true;
  }
  if (isForbiddenIpAddress(lower)) {
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
    const normalizedHost = normalizeHostname(parsed.hostname);
    if (isForbiddenHostname(normalizedHost)) {
      return null;
    }
    parsed.hostname = normalizedHost;
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
};

const isExternalHlsProxyError = (
  value: unknown,
): value is ExternalHlsProxyError => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ExternalHlsProxyError>;
  return (
    typeof candidate.code === "string" && typeof candidate.statusCode === "number"
  );
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
  let inFlightUpstreamFetches = 0;

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

  const assertSafeFetchTarget = async (targetUrl: URL): Promise<void> => {
    if (!isAllowedHostname(targetUrl.hostname)) {
      throw {
        code: "forbidden_proxy_target",
        statusCode: 403,
      } satisfies ExternalHlsProxyError;
    }

    const hasOnlyPublicResolution = await resolvesToOnlyPublicIps(
      targetUrl.hostname,
    );
    if (!hasOnlyPublicResolution) {
      throw {
        code: "forbidden_proxy_target",
        statusCode: 403,
      } satisfies ExternalHlsProxyError;
    }
  };

  const fetchWithValidatedRedirects = async (
    initialTarget: URL,
  ): Promise<{ response: Response; finalTarget: URL }> => {
    let currentTarget = initialTarget;

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      await assertSafeFetchTarget(currentTarget);

      let response: Response;
      try {
        response = await fetch(currentTarget.toString(), {
          headers: {
            "user-agent": "simple-stream-party/1.0",
            accept: "*/*",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
        });
      } catch {
        throw {
          code: "upstream_request_failed",
          statusCode: 502,
        } satisfies ExternalHlsProxyError;
      }

      if (
        response.status !== 301 &&
        response.status !== 302 &&
        response.status !== 303 &&
        response.status !== 307 &&
        response.status !== 308
      ) {
        return { response, finalTarget: currentTarget };
      }

      const location = response.headers.get("location");
      if (!location) {
        throw {
          code: "upstream_request_failed",
          statusCode: 502,
        } satisfies ExternalHlsProxyError;
      }

      const redirected = parseAndValidateTargetUrl(
        new URL(location, currentTarget).toString(),
      );
      if (!redirected) {
        throw {
          code: "forbidden_proxy_target",
          statusCode: 403,
        } satisfies ExternalHlsProxyError;
      }

      currentTarget = redirected;
    }

    throw {
      code: "upstream_request_failed",
      statusCode: 502,
    } satisfies ExternalHlsProxyError;
  };

  const acquireUpstreamFetchSlot = (): (() => void) => {
    if (inFlightUpstreamFetches >= MAX_CONCURRENT_UPSTREAM_FETCHES) {
      throw {
        code: "proxy_overloaded",
        statusCode: 503,
      } satisfies ExternalHlsProxyError;
    }

    inFlightUpstreamFetches += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      inFlightUpstreamFetches -= 1;
    };
  };

  const readResponseBodyWithLimit = async (
    response: Response,
    maxBytes: number,
  ): Promise<Buffer> => {
    const stream = response.body;
    if (!stream) {
      return Buffer.alloc(0);
    }

    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (!value || value.byteLength === 0) {
          continue;
        }

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw {
            code: "upstream_response_too_large",
            statusCode: 502,
          } satisfies ExternalHlsProxyError;
        }

        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (isExternalHlsProxyError(error)) {
        throw error;
      }
      throw {
        code: "upstream_request_failed",
        statusCode: 502,
      } satisfies ExternalHlsProxyError;
    }

    return Buffer.concat(chunks, totalBytes);
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

    const releaseSlot = acquireUpstreamFetchSlot();
    try {
      const { response, finalTarget } =
        await fetchWithValidatedRedirects(validatedTarget);

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
      const isPlaylist =
        finalTarget.pathname.toLowerCase().endsWith(".m3u8") ||
        isPlaylistContentType(upstreamContentType);
      const maxBytes = isPlaylist
        ? MAX_UPSTREAM_PLAYLIST_BYTES
        : MAX_UPSTREAM_SEGMENT_BYTES;

      const declaredContentLengthHeader = response.headers.get("content-length");
      if (declaredContentLengthHeader) {
        const declaredContentLength = Number.parseInt(
          declaredContentLengthHeader,
          10,
        );
        if (
          Number.isFinite(declaredContentLength) &&
          declaredContentLength > maxBytes
        ) {
          throw {
            code: "upstream_response_too_large",
            statusCode: 502,
          } satisfies ExternalHlsProxyError;
        }
      }

      const rawBody = await readResponseBodyWithLimit(response, maxBytes);

      let body = rawBody;
      let contentType = upstreamContentType || "application/octet-stream";
      let cacheControl = "public, max-age=60";
      let ttlMs = SEGMENT_TTL_MS;

      if (isPlaylist) {
        const rewritten = rewritePlaylist(
          rawBody.toString("utf8"),
          finalTarget.toString(),
          videoId,
        );
        body = Buffer.from(rewritten, "utf8");
        if (body.length > MAX_UPSTREAM_PLAYLIST_BYTES) {
          throw {
            code: "upstream_response_too_large",
            statusCode: 502,
          } satisfies ExternalHlsProxyError;
        }
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
    } finally {
      releaseSlot();
    }
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
