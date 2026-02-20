export type DedupablePlaybackAction = "play" | "pause" | "seek";

export type PlaybackBurstEvent<TMeta = undefined> = {
  action: DedupablePlaybackAction;
  playbackTimeSec: number;
  meta: TMeta;
};

export const dedupePlaybackBurst = <TMeta>(
  events: PlaybackBurstEvent<TMeta>[],
): PlaybackBurstEvent<TMeta>[] => {
  if (events.length <= 1) {
    return events;
  }

  // A seek in a short burst typically comes with play/pause noise from clients.
  // Emit only the final seek to keep activity deterministic and clean.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.action === "seek") {
      return [events[i]];
    }
  }

  return events;
};
