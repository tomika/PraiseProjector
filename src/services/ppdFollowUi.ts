export type FullViewPpdFollowUi = {
  leaderModeAvailable: boolean;
  leaderModeActive: boolean;
  leaderButtonDisabled: boolean;
  leaderSelectDisabled: boolean;
  playlistDisabled: boolean;
};

/** Capability-derived full-view controls while following a session. */
export function deriveFullViewPpdFollowUi(following: boolean, accessAllowsLeaderMode: boolean, leaderMode: boolean): FullViewPpdFollowUi {
  const leaderModeAvailable = following && accessAllowsLeaderMode;
  const leaderModeActive = leaderModeAvailable && leaderMode;
  return {
    leaderModeAvailable,
    leaderModeActive,
    leaderButtonDisabled: following && !leaderModeAvailable,
    leaderSelectDisabled: following,
    playlistDisabled: following && !leaderModeActive,
  };
}
