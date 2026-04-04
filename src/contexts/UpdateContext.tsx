import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

interface UpdateInfo {
  version: string;
}

interface UpdateContextValue {
  updateAvailable: UpdateInfo | null;
  downloadProgress: number | null;
  updateDownloaded: UpdateInfo | null;
  checking: boolean;
  hasUpdate: boolean;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  installInProgress: boolean;
  installError: string | null;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

export const UpdateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [updateAvailable, setUpdateAvailable] = useState<UpdateInfo | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [updateDownloaded, setUpdateDownloaded] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installInProgress, setInstallInProgress] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanupFns: (() => void)[] = [];

    if (api.onUpdateAvailable) {
      cleanupFns.push(
        api.onUpdateAvailable((info) => {
          setUpdateAvailable(info);
        })
      );
    }

    if (api.onUpdateNotAvailable) {
      cleanupFns.push(
        api.onUpdateNotAvailable(() => {
          setUpdateAvailable(null);
        })
      );
    }

    if (api.onUpdateDownloadProgress) {
      cleanupFns.push(
        api.onUpdateDownloadProgress((progress) => {
          setDownloadProgress(progress.percent);
        })
      );
    }

    if (api.onUpdateDownloaded) {
      cleanupFns.push(
        api.onUpdateDownloaded((info) => {
          setUpdateDownloaded(info);
          setDownloadProgress(null);
        })
      );
    }

    return () => cleanupFns.forEach((fn) => fn());
  }, []);

  const checkForUpdates = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.checkForUpdates) return;
    setChecking(true);
    try {
      const result = await api.checkForUpdates();
      const available = result?.available ?? result?.updateAvailable ?? false;

      if (available && result?.version) {
        setUpdateAvailable({ version: result.version });
      } else if (!available) {
        setUpdateAvailable(null);
      }
    } finally {
      setChecking(false);
    }
  }, []);

  const downloadUpdate = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.downloadUpdate) return;
    setDownloadProgress(0);
    await api.downloadUpdate();
  }, []);

  const installUpdate = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.installUpdate) return;
    setInstallInProgress(true);
    setInstallError(null);
    try {
      const result = (await api.installUpdate?.()) as { success?: boolean; manualRequired?: boolean; error?: string } | undefined;
      if (result?.success) {
        // Update is being installed, app will restart
        return;
      }
      if (result?.manualRequired) {
        setInstallError("Manual update required. Please visit the releases page.");
      } else if (result?.error) {
        setInstallError(result.error);
      } else {
        setInstallError("Update installation failed");
      }
    } catch (err) {
      setInstallError((err as Error).message || "Update installation failed");
    } finally {
      setInstallInProgress(false);
    }
  }, []);

  const hasUpdate = updateAvailable !== null || updateDownloaded !== null;

  return (
    <UpdateContext.Provider
      value={{
        updateAvailable,
        downloadProgress,
        updateDownloaded,
        checking,
        hasUpdate,
        checkForUpdates,
        downloadUpdate,
        installUpdate,
        installInProgress,
        installError,
      }}
    >
      {children}
    </UpdateContext.Provider>
  );
};

export const useUpdate = (): UpdateContextValue => {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate must be used within UpdateProvider");
  return ctx;
};
