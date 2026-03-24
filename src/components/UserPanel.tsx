import React, { useState, useEffect, useRef, useCallback } from "react";
import { Icon, IconType } from "../services/IconService";
import { useLeader } from "../contexts/LeaderContext";
import { useAuth } from "../contexts/AuthContext";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { useLocalization } from "../localization/LocalizationContext";
import { useTooltips } from "../localization/TooltipContext";
import { cloudApi } from "../../common/cloudApi";
import { useSettings } from "../hooks/useSettings";
import { Database } from "../classes/Database";
import AuthDialog from "./AuthDialog";

const MIN_PEEK_INTERVAL_SECONDS = 10;
const PEEK_POLL_TICK_MS = 1000; // check every second whether it's time to query

interface UserPanelProps {
  onOpenLeaderSettings?: (leaderId: string | null) => void;
  onSyncClick?: () => void;
  onExportDatabase?: () => void;
  onImportDatabase?: () => void;
  onReplaceDatabase?: () => void;
  onSettingsClick?: () => void;
  onSongCheckClick?: () => void;
}

const UserPanel: React.FC<UserPanelProps> = ({
  onOpenLeaderSettings,
  onSyncClick,
  onExportDatabase,
  onImportDatabase,
  onReplaceDatabase,
  onSettingsClick,
  onSongCheckClick,
}) => {
  const { selectedLeader, setSelectedLeaderId, allLeaders } = useLeader();
  const { isGuest, isLoading: isAuthLoading, username, user, logout, login, commitSession, setOnLoginSuccess } = useAuth();
  const { settings } = useSettings();
  const { showMessage, showConfirmAsync } = useMessageBox();
  const { t } = useLocalization();
  const { tt } = useTooltips();
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const [pendingSongCount, setPendingSongCount] = useState(0);
  const [cloudDbVersion, setCloudDbVersion] = useState<number | null>(null);
  const [localDbVersion, setLocalDbVersion] = useState(0);
  const [updatedSongCount, setUpdatedSongCount] = useState(0);
  const [updatedProfileCount, setUpdatedProfileCount] = useState(0);
  const [cloudAuthFailed, setCloudAuthFailed] = useState(false);
  const syncMenuRef = useRef<HTMLDivElement>(null);
  const lastPeekCheckRef = useRef(0);
  // Tracks which action to perform after successful login (null = none).
  const pendingActionAfterLoginRef = useRef<(() => void) | null>(null);
  // Keep refs to the latest callbacks so deferred calls after login
  // always use the re-rendered callback with fresh auth state.
  const onSyncClickRef = useRef(onSyncClick);
  const onSongCheckClickRef = useRef(onSongCheckClick);

  useEffect(() => {
    onSyncClickRef.current = onSyncClick;
    onSongCheckClickRef.current = onSongCheckClick;
  }, [onSyncClick, onSongCheckClick]);

  const peekIntervalSeconds = Math.max(MIN_PEEK_INTERVAL_SECONDS, (settings?.serverPeekIntervalMinutes ?? 60) * 60);
  const peekIntervalMs = peekIntervalSeconds * 1000;

  // Keep cloudApi's peek cache TTL in sync with the user-configured interval.
  useEffect(() => {
    // Set TTL slightly shorter than the interval to ensure the cache expires before we check it again.
    cloudApi.setPeekCacheTtl(Math.max(1000, peekIntervalMs - 100));
  }, [peekIntervalMs]);

  const fetchPeek = useCallback(async () => {
    try {
      const peek = await cloudApi.fetchPeek();
      setPendingSongCount(peek.pendingSongCount ?? 0);
      setCloudDbVersion(peek.dbVersion ?? null);
      setCloudAuthFailed(false);
    } catch {
      // During initial auth restore, avoid showing cloud-auth-failed state.
      if (!isGuest && !isAuthLoading) setCloudAuthFailed(true);
      setPendingSongCount(0);
      setCloudDbVersion(null);
    }
    lastPeekCheckRef.current = Date.now();
  }, [isGuest, isAuthLoading]);

  // Keep a stable ref so the polling effect doesn't need fetchPeek in its deps.
  // This prevents auth-state flickers (isGuest/isAuthLoading) from re-creating
  // the interval and firing a kickoff peek on every change.
  const fetchPeekRef = useRef(fetchPeek);
  useEffect(() => {
    fetchPeekRef.current = fetchPeek;
  }, [fetchPeek]);

  const userDisplayName = isAuthLoading ? user?.login || username || t("Loading") : !isGuest ? user?.login || username : t("Guest");

  useEffect(() => {
    let cleanupDbListener = () => {};
    let mounted = true;

    const subscribeToDb = async () => {
      cleanupDbListener();
      const db = await Database.waitForReady();
      if (!mounted) return;
      setLocalDbVersion(db.version);
      setUpdatedSongCount(db.countUpdatedSongs());
      setUpdatedProfileCount(db.countUpdatedProfiles());
      const onDbUpdated = () => {
        setLocalDbVersion(db.version);
        setUpdatedSongCount(db.countUpdatedSongs());
        setUpdatedProfileCount(db.countUpdatedProfiles());
      };
      db.emitter.on("db-updated", onDbUpdated);
      cleanupDbListener = () => db.emitter.off("db-updated", onDbUpdated);
    };

    const handleDatabaseSwitched = () => {
      subscribeToDb();
    };

    subscribeToDb();
    window.addEventListener("pp-database-switched", handleDatabaseSwitched);

    return () => {
      mounted = false;
      cleanupDbListener();
      window.removeEventListener("pp-database-switched", handleDatabaseSwitched);
    };
  }, []);

  useEffect(() => {
    const tick = setInterval(() => {
      if (Date.now() - lastPeekCheckRef.current >= peekIntervalMs) {
        fetchPeekRef.current();
      }
    }, PEEK_POLL_TICK_MS);

    const kickoff = setTimeout(() => {
      fetchPeekRef.current();
    }, 0);

    return () => {
      clearInterval(tick);
      clearTimeout(kickoff);
    };
  }, [username, peekIntervalMs]);

  // Listen for external refresh requests (e.g. after SongCheckDialog processes songs)
  useEffect(() => {
    const handleRefresh = () => {
      cloudApi.invalidatePeekCache();
      fetchPeekRef.current();
    };
    window.addEventListener("pp-pending-songs-changed", handleRefresh);
    return () => window.removeEventListener("pp-pending-songs-changed", handleRefresh);
  }, []);

  // Register callback for auto-selecting leader after login
  useEffect(() => {
    setOnLoginSuccess((leaderId?: string) => {
      if (leaderId) {
        setSelectedLeaderId(leaderId);
      }
    });
  }, [setOnLoginSuccess, setSelectedLeaderId]);

  // Close sync menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (syncMenuRef.current && !syncMenuRef.current.contains(event.target as Node)) {
        setShowSyncMenu(false);
      }
    };

    if (showSyncMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showSyncMenu]);

  // Allow other parts of the app to request the login dialog with an optional
  // pending action to execute after successful login.
  useEffect(() => {
    const handleOpenAuthDialog = (e: Event) => {
      const action = (e as CustomEvent).detail?.action;
      if (action === "songCheck") {
        pendingActionAfterLoginRef.current = () => onSongCheckClickRef.current?.();
      } else {
        // Default: sync
        pendingActionAfterLoginRef.current = () => onSyncClickRef.current?.();
      }
      setShowAuthDialog(true);
    };

    window.addEventListener("pp-open-auth-dialog", handleOpenAuthDialog);
    return () => window.removeEventListener("pp-open-auth-dialog", handleOpenAuthDialog);
  }, []);

  // Handle leader selection change (matching C# cmbLeader.SelectedIndexChanged)
  const handleLeaderChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const leaderId = event.target.value || null;
    setSelectedLeaderId(leaderId);
  };

  const handleUserButtonClick = () => {
    setShowAuthDialog(true);
  };

  const handleAuthConfirm = async (username: string, password: string, token: string) => {
    // If token is provided, use it; otherwise use password for authentication
    const success = await login(username, token || password);
    if (success) {
      setCloudAuthFailed(false);
      setShowAuthDialog(false);
      fetchPeek();

      // In Electron mode, ask user whether to persist login (Remember Me).
      const isElectron = typeof window !== "undefined" && !!window.electronAPI;
      if (isElectron) {
        showConfirmAsync(t("RememberMeTitle"), t("RememberMeMessage"), {
          confirmText: t("Yes"),
        }).then((rememberMe) => {
          if (rememberMe) {
            commitSession();
            window.electronAPI?.persistCookies?.();
          } else {
            window.electronAPI?.clearPersistedCookies?.();
          }
        });
      }

      if (pendingActionAfterLoginRef.current) {
        const action = pendingActionAfterLoginRef.current;
        pendingActionAfterLoginRef.current = null;
        // Defer so React commits the auth state update first; the ref-based
        // callbacks pick up the re-rendered version with fresh auth state.
        setTimeout(() => action(), 0);
      }
    } else {
      showMessage(t("LoginFailed"), t("LoginFailedCheckCredentials"));
    }
  };

  const handleLogout = async () => {
    await logout();
    pendingActionAfterLoginRef.current = null;
    setShowAuthDialog(false);
    fetchPeek();
  };

  const handleLeaderSettingsClick = () => {
    onOpenLeaderSettings?.(selectedLeader?.id || null);
  };

  const showSyncControls = !!(onSyncClick || onExportDatabase || onImportDatabase || onReplaceDatabase);
  const localChangeCount = updatedSongCount + updatedProfileCount;
  const remoteChangeCount = !isGuest && cloudDbVersion !== null ? cloudDbVersion - localDbVersion : 0;

  return (
    <div>
      <div className="form-group d-flex align-items-center mb-1">
        <button className="btn btn-light mr-2 sidebar-icon-btn" aria-label="User" onClick={handleUserButtonClick}>
          <Icon type={IconType.USER} />
        </button>
        <div className="user-login-input-wrapper mr-2">
          <input
            type="text"
            readOnly
            className="form-control user-login-input"
            value={userDisplayName ?? ""}
            aria-label="User Name"
            onClick={handleUserButtonClick}
            style={{ cursor: "pointer" }}
          />
        </div>
        {showSyncControls && (
          <div className="btn-group position-relative user-sync-group mr-2" ref={syncMenuRef}>
            <button className="btn btn-light user-sync-main-btn" aria-label="Sync" title={tt("toolbar_sync")} onClick={onSyncClick}>
              <Icon type={IconType.SYNC} />
              {localChangeCount && !isGuest ? (
                <span className="pending-badge-abs sync-version-indicator-topleft" aria-hidden="true">
                  {localChangeCount ? localChangeCount + "↑" : ""}
                </span>
              ) : null}
              {remoteChangeCount ? (
                <span className="pending-badge-abs sync-version-indicator-bottomleft" aria-hidden="true">
                  {remoteChangeCount ? remoteChangeCount + "↓" : ""}
                </span>
              ) : null}
            </button>
            <button
              className="btn btn-light dropdown-toggle-split sync-menu-toggle"
              aria-label="Sync Menu"
              title={t("SyncMenu")}
              onClick={() => setShowSyncMenu(!showSyncMenu)}
            >
              <span className="sync-menu-indicator">▾</span>
            </button>
            {cloudAuthFailed ? (
              <span className="pending-badge-abs cloud-auth-failed" title={t("PleaseLoginAgain")}>
                <Icon type={IconType.CLOUD_AUTH_FAILED} />
              </span>
            ) : pendingSongCount > 0 ? (
              <span className="badge bg-danger rounded-pill pending-badge-abs">{pendingSongCount > 99 ? "99+" : pendingSongCount}</span>
            ) : null}
            {showSyncMenu && (
              <div className="dropdown-menu show sync-dropdown-menu">
                <button
                  className="dropdown-item d-flex align-items-center justify-content-between"
                  onClick={() => {
                    setShowSyncMenu(false);
                    onSyncClick?.();
                  }}
                >
                  {t("MenuSyncDatabase")}
                  {localChangeCount || remoteChangeCount ? (
                    <span className="sync-menu-item-version-indicator" aria-hidden="true">
                      🗘
                    </span>
                  ) : null}
                </button>
                {onSongCheckClick && !isGuest && (
                  <button
                    type="button"
                    className="dropdown-item d-flex align-items-center justify-content-between"
                    onClick={() => {
                      setShowSyncMenu(false);
                      onSongCheckClick();
                    }}
                  >
                    {t("SongCheckTitle")}
                    {pendingSongCount > 0 && (
                      <span className="badge bg-danger rounded-pill ms-2">{pendingSongCount > 99 ? "99+" : pendingSongCount}</span>
                    )}
                  </button>
                )}
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setShowSyncMenu(false);
                    onExportDatabase?.();
                  }}
                >
                  {t("MenuExportDatabase")}
                </button>
                <button
                  className="dropdown-item text-danger"
                  onClick={() => {
                    setShowSyncMenu(false);
                    onImportDatabase?.();
                  }}
                >
                  {t("MenuImportDatabase")}
                </button>
                <div className="dropdown-divider"></div>
                <button
                  className="dropdown-item text-danger"
                  onClick={() => {
                    setShowSyncMenu(false);
                    onReplaceDatabase?.();
                  }}
                >
                  {t("MenuReplaceDatabase")}
                </button>
              </div>
            )}
          </div>
        )}
        {onSettingsClick && (
          <button
            className="btn btn-light user-sync-main-btn user-sync-height-btn"
            aria-label="Settings"
            title={tt("toolbar_settings")}
            onClick={onSettingsClick}
          >
            <Icon type={IconType.SETTINGS} />
          </button>
        )}
      </div>
      <div className="form-group d-flex align-items-center mb-1">
        <button className="btn btn-light mr-2 sidebar-icon-btn" aria-label="Leader" onClick={handleLeaderSettingsClick}>
          <Icon type={IconType.LEADER} />
        </button>
        <div className="flex-grow-1 user-leader-select-wrapper">
          <select
            className="form-control"
            aria-label="Leader Selection"
            value={selectedLeader?.id || ""}
            onChange={handleLeaderChange}
            disabled={allLeaders.length === 0}
          >
            <option value=""></option>
            {[...allLeaders]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((leader) => (
                <option key={leader.id} value={leader.id}>
                  {leader.name}
                </option>
              ))}
          </select>
        </div>
      </div>
      {showAuthDialog && (
        <AuthDialog
          onConfirm={handleAuthConfirm}
          onCancel={() => {
            pendingActionAfterLoginRef.current = null;
            setShowAuthDialog(false);
          }}
          showOffline={true}
          onLogout={handleLogout}
          initialUsername={user?.login || username || ""}
        />
      )}
    </div>
  );
};

export default UserPanel;
