import { parseAbcRange } from "../common/abc-range";
import type { Display, DisplayUpdateRequest } from "../common/pp-types";
import { deserializePlaylist } from "../common/pp-utils";

function parseOptionalInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = parseInt(String(raw), 10);
  return isNaN(value) ? undefined : value;
}

/**
 * The update a `/display_update` or `/song_update` body asks the renderer to
 * apply (App.tsx remoteDisplayUpdateHandler keeps whatever is undefined).
 *
 * An id-only update (a transpose/capo preference, a legacy song selection) sends
 * no line range: it leaves the highlight alone, and the title and instructions it
 * does not send. A full update without them still clears them, as it always did.
 */
export function parseRemoteDisplayUpdate(command: DisplayUpdateRequest["command"], params: Record<string, unknown>): DisplayUpdateRequest {
  const idOnly = params.from == null && params.to == null;
  let sectionRepeatCounts: Display["sectionRepeatCounts"];
  if (Array.isArray(params.sectionRepeatCounts)) {
    sectionRepeatCounts = params.sectionRepeatCounts as Display["sectionRepeatCounts"];
  } else if (typeof params.sectionRepeatCounts === "string" && params.sectionRepeatCounts) {
    try {
      sectionRepeatCounts = JSON.parse(params.sectionRepeatCounts) as Display["sectionRepeatCounts"];
    } catch {
      sectionRepeatCounts = undefined;
    }
  }
  return {
    command,
    abcRange: parseAbcRange(params.abcRange),
    id: (params.id as string) || "",
    from: idOnly ? undefined : parseInt((params.from as string) || "0", 10),
    to: idOnly ? undefined : parseInt((params.to as string) || "0", 10),
    section: parseOptionalInt(params.section),
    sectionRepeatNonce: parseOptionalInt(params.sectionRepeatNonce),
    sectionRepeatCounts,
    // Undefined means "no change" for transpose/capo.
    transpose: parseOptionalInt(params.transpose),
    capo: parseOptionalInt(params.capo),
    instructions: idOnly ? (params.instructions as string | undefined) : (params.instructions as string) || "",
    title: idOnly ? (params.title as string | undefined) : (params.title as string) || "",
    playlist: deserializePlaylist(params.playlist),
  };
}
