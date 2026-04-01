import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type HlsStatus = "pending" | "processing" | "ready" | "error";

export type HlsVideoState = {
  videoId: string;
  status: HlsStatus;
  hlsDir: string;
  error?: string;
};

export type HlsTranscoder = {
  getStatus: (videoId: string) => HlsStatus;
  getHlsDir: (videoId: string) => string;
  getPlaylistPath: (videoId: string) => string;
  ensureHls: (
    videoId: string,
    sourceFilePath: string,
    onDone?: (state: HlsVideoState) => void,
  ) => HlsVideoState;
  isReady: (videoId: string) => boolean;
  transcodeAll: (
    videos: { id: string; fileName: string }[],
    dataDir: string,
    onVideoDone?: (videoId: string, sourceFilePath: string) => void,
  ) => void;
};

export const createHlsTranscoder = (dataDir: string): HlsTranscoder => {
  const hlsBaseDir = path.join(dataDir, "hls");
  const states = new Map<string, HlsVideoState>();

  const getHlsDir = (videoId: string): string =>
    path.join(hlsBaseDir, videoId);

  const getPlaylistPath = (videoId: string): string =>
    path.join(getHlsDir(videoId), "playlist.m3u8");

  const getStatus = (videoId: string): HlsStatus =>
    states.get(videoId)?.status ?? "pending";

  const isReady = (videoId: string): boolean =>
    getStatus(videoId) === "ready";

  const checkExistingHls = async (videoId: string): Promise<boolean> => {
    const playlistPath = getPlaylistPath(videoId);
    try {
      const stat = await fsp.stat(playlistPath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  };

  const probeCanCopyCodec = (sourceFilePath: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const probe = spawn("ffprobe", [
        "-v", "quiet",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name",
        "-of", "csv=p=0",
        sourceFilePath,
      ]);

      let output = "";
      probe.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      probe.on("close", (code) => {
        if (code !== 0) {
          resolve(false);
          return;
        }
        const codec = output.trim().toLowerCase();
        // These codecs can be transmuxed into TS containers directly
        const copyable = ["h264", "hevc", "h265", "mpeg2video", "mpeg4"];
        resolve(copyable.includes(codec));
      });
      probe.on("error", () => resolve(false));
    });
  };

  const runFfmpeg = (
    sourceFilePath: string,
    hlsDir: string,
    canCopy: boolean,
  ): Promise<{ ok: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const playlistPath = path.join(hlsDir, "playlist.m3u8");
      const segmentPattern = path.join(hlsDir, "segment_%03d.ts");

      const args: string[] = [
        "-y",
        "-i", sourceFilePath,
        "-map", "0:v",     // Map first video stream
        "-map", "0:a?",    // Map first audio stream if present
        "-sn",             // Disable subtitle copying
        "-hls_time", "6",
        "-hls_list_size", "0",
        "-hls_segment_filename", segmentPattern,
        "-hls_playlist_type", "vod",
      ];

      if (canCopy) {
        // Transmux: copy both audio and video codecs
        args.push("-c", "copy");
      } else {
        // Re-encode: H.264 video + AAC audio
        args.push(
          "-c:v", "libx264",
          "-preset", "fast",
          "-crf", "23",
          "-c:a", "aac",
          "-b:a", "128k",
        );
      }

      args.push("-f", "hls", playlistPath);

      const ffmpeg = spawn("ffmpeg", args);

      let stderr = "";
      ffmpeg.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve({ ok: true });
        } else {
          resolve({
            ok: false,
            error: `ffmpeg exited with code ${code}: ${stderr.slice(-500)}`,
          });
        }
      });

      ffmpeg.on("error", (err) => {
        resolve({ ok: false, error: `ffmpeg spawn error: ${err.message}` });
      });
    });
  };

  const ensureHls = (
    videoId: string,
    sourceFilePath: string,
    onDone?: (state: HlsVideoState) => void,
  ): HlsVideoState => {
    const existing = states.get(videoId);
    if (existing && (existing.status === "ready" || existing.status === "processing")) {
      return existing;
    }

    const hlsDir = getHlsDir(videoId);
    const state: HlsVideoState = {
      videoId,
      status: "processing",
      hlsDir,
    };
    states.set(videoId, state);

    void (async () => {
      try {
        // Check if HLS already exists (from previous run)
        const alreadyExists = await checkExistingHls(videoId);
        if (alreadyExists) {
          state.status = "ready";
          states.set(videoId, { ...state });
          onDone?.({ ...state });
          return;
        }

        // Create HLS output directory
        await fsp.mkdir(hlsDir, { recursive: true });

        // Probe codec to decide copy vs re-encode
        const canCopy = await probeCanCopyCodec(sourceFilePath);
        console.log(
          `[hls] transcoding ${videoId} (${canCopy ? "transmux" : "re-encode"})...`,
        );

        const result = await runFfmpeg(sourceFilePath, hlsDir, canCopy);

        if (result.ok) {
          state.status = "ready";
          console.log(`[hls] transcoding complete: ${videoId}`);
        } else {
          state.status = "error";
          state.error = result.error;
          console.error(`[hls] transcoding failed: ${videoId}`, result.error);
        }

        states.set(videoId, { ...state });
        onDone?.({ ...state });
      } catch (err) {
        state.status = "error";
        state.error = err instanceof Error ? err.message : String(err);
        states.set(videoId, { ...state });
        console.error(`[hls] transcoding error: ${videoId}`, state.error);
        onDone?.({ ...state });
      }
    })();

    return state;
  };

  const transcodeAll = (
    videos: { id: string; fileName: string }[],
    videosDataDir: string,
    onVideoDone?: (videoId: string, sourceFilePath: string) => void,
  ): void => {
    // Process one video at a time to avoid overloading the system
    const queue = [...videos];

    const processNext = () => {
      const video = queue.shift();
      if (!video) {
        console.log("[hls] all videos transcoded");
        return;
      }

      const sourceFilePath = path.join(videosDataDir, video.fileName);
      ensureHls(video.id, sourceFilePath, (state) => {
        if (onVideoDone) {
          onVideoDone(video.id, sourceFilePath);
        }
        processNext();
      });
    };

    processNext();
  };

  return {
    getStatus,
    getHlsDir,
    getPlaylistPath,
    ensureHls,
    isReady,
    transcodeAll,
  };
};
