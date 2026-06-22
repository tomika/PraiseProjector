/**
 * RestClientApi — the canonical ClientApi adapter.
 *
 * Talks HTTP via the shared {@link cloudApi}, so a single implementation serves
 * all three runtime contexts that need it:
 *   - a remote browser served by the Electron embedded webserver (base URL = the
 *     serving origin, derived from window.location in src/config.ts), and
 *   - a standalone web / Android client pointed at the cloud.
 *
 * The Electron desktop window may also use this adapter (against its own
 * loopback webserver) or the optional in-process Direct adapter.
 */

import type {
  AuthApi,
  ClientApi,
  ClientCapabilities,
  ClientConfig,
  ClientMode,
  DeviceApi,
  DisplayApi,
  PlaylistApi,
  SessionApi,
  SongApi,
  Unsubscribe,
} from "../ClientApi";
import { RestCore } from "./RestCore";
import { createAuthApi, createDeviceApi, createDisplayApi, createPlaylistApi, createSessionApi, createSongApi } from "./restPorts";

export class RestClientApi implements ClientApi {
  private readonly core = new RestCore();

  readonly song: SongApi;
  readonly playlist: PlaylistApi;
  readonly display: DisplayApi;
  readonly session: SessionApi;
  readonly auth: AuthApi;
  readonly device: DeviceApi;

  constructor() {
    this.song = createSongApi(this.core);
    this.playlist = createPlaylistApi(this.core);
    this.display = createDisplayApi(this.core);
    this.session = createSessionApi(this.core);
    this.auth = createAuthApi(this.core);
    this.device = createDeviceApi();
  }

  get mode(): ClientMode {
    return this.core.mode;
  }

  init(config: ClientConfig): Promise<void> {
    return this.core.init(config);
  }

  dispose(): void {
    this.core.dispose();
  }

  getCapabilities(): ClientCapabilities {
    return this.core.getCapabilities();
  }

  subscribeCapabilities(callback: (capabilities: ClientCapabilities) => void): Unsubscribe {
    return this.core.capabilityEvents.add(callback);
  }

  setLeaderMode(enabled: boolean): void {
    this.core.setLeaderMode(enabled);
  }
}
