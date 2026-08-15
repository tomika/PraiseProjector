import type { SongData } from "../../common/pp-types";

export type PpdSongFallbackOptions = {
  songId: string;
  followingPpd: boolean;
  cache: Map<string, SongData>;
  loadLocal(): SongData | undefined | Promise<SongData | undefined>;
  loadRemote(songId: string): Promise<SongData>;
};

/** Preserve the local zero-network fast path and fetch only a genuine PPD miss. */
export async function loadPpdSongLocalFirst(options: PpdSongFallbackOptions): Promise<SongData | undefined> {
  try {
    const local = await options.loadLocal();
    if (local) return local;
  } catch (error) {
    if (!options.followingPpd) throw error;
  }
  if (!options.followingPpd) return undefined;
  const cached = options.cache.get(options.songId);
  if (cached) return cached;
  const remote = await options.loadRemote(options.songId);
  options.cache.set(options.songId, remote);
  return remote;
}
