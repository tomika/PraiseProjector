import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { Leader } from "../../db-common/Leader";
import { Database } from "../../db-common/Database";
import { useSettings } from "../hooks/useSettings";
import { v4 as uuidv4 } from "uuid";

interface LeaderContextType {
  selectedLeader: Leader | null;
  setSelectedLeaderId: (leaderId: string | null) => void;
  allLeaders: Leader[];
  guestLeaderId: string;
}

const LeaderContext = createContext<LeaderContextType | undefined>(undefined);

export const useLeader = (): LeaderContextType => {
  const context = useContext(LeaderContext);
  if (!context) {
    throw new Error("useLeader must be used within LeaderProvider");
  }
  return context;
};

// Sync leader name to backend (for UDP offer message - C# uses cmbLeader.Text)
const syncLeaderNameToBackend = (leaderName: string) => {
  if (window.electronAPI?.syncLeaderName) {
    window.electronAPI.syncLeaderName(leaderName);
  }
};

interface LeaderProviderProps {
  children: ReactNode;
}

export const LeaderProvider: React.FC<LeaderProviderProps> = ({ children }) => {
  const { settings, updateSettingWithAutoSave } = useSettings();
  const [allLeaders, setAllLeaders] = useState<Leader[]>([]);
  const [selectedLeader, setSelectedLeader] = useState<Leader | null>(null);
  // Track the previous leaders list length to detect when it genuinely changes
  // (e.g. after sync or database switch), vs just re-running the effect.
  const prevLeadersCountRef = React.useRef<number | null>(null);
  // Ensure each client instance gets a persistent guest ID immediately (synchronous on first render).
  // We read/write localStorage in the state initializer so `guestLeaderId` is available on first render
  // (avoids race conditions where other code needs the id before an effect runs).
  const [guestLeaderId] = useState<string>(() => {
    try {
      let guestLeader = localStorage.getItem("pp-guest-leader")?.trim();
      if (!guestLeader) {
        guestLeader = uuidv4();
        try {
          localStorage.setItem("pp-guest-leader", guestLeader);
        } catch {
          // ignore storage write errors (e.g. private mode)
        }
      }
      return guestLeader;
    } catch {
      // localStorage may be unavailable in some environments — generate a transient id
      return uuidv4();
    }
  });

  // Load leaders from database - re-run when user changes (database switches)
  useEffect(() => {
    let dbCleanup: (() => void) | undefined;
    let isMounted = true;

    const loadLeaders = async () => {
      const db = await Database.waitForReady();
      if (!isMounted) return;
      // Clone to create new array reference so React detects changes
      const leaders = db.getAllLeaders().slice();
      const prevCount = prevLeadersCountRef.current;
      const leadersListChanged = prevCount === null || prevCount !== leaders.length;
      prevLeadersCountRef.current = leaders.length;
      setAllLeaders(leaders);

      // Restore selected leader from settings
      if (settings?.selectedLeader) {
        const leader = db.getLeaderById(settings.selectedLeader) || db.getLeaderByName(settings.selectedLeader);
        if (leader) {
          setSelectedLeader(leader);
        } else {
          setSelectedLeader(null);
        }
      } else if (leaders.length === 1 && leadersListChanged) {
        // Auto-select only when leaders list was just populated/changed
        // (not when the user explicitly cleared their selection)
        setSelectedLeader(leaders[0]);
      } else {
        setSelectedLeader(null);
      }
    };

    const subscribeToDb = async () => {
      const db = await Database.waitForReady();
      if (!isMounted) return;
      db.emitter.on("db-updated", loadLeaders);
      dbCleanup = () => {
        db.emitter.off("db-updated", loadLeaders);
      };
    };

    // Handler for database switch events (user login/logout)
    const handleDatabaseSwitched = () => {
      // Clean up old database subscription
      dbCleanup?.();
      // Subscribe to new database and reload
      subscribeToDb();
      // Reset ref so auto-select can fire for the new database
      prevLeadersCountRef.current = null;
      loadLeaders();
    };

    // Handler for leaders changed event (from settings dialog)
    const handleLeadersChanged = () => {
      // Reset ref so auto-select can fire if leaders were added/removed
      prevLeadersCountRef.current = null;
      loadLeaders();
    };

    // Initial load and subscribe
    loadLeaders();
    subscribeToDb();

    // Listen for database switch events
    window.addEventListener("pp-database-switched", handleDatabaseSwitched);
    // Listen for leaders changed events (from settings)
    window.addEventListener("pp-leaders-changed", handleLeadersChanged);

    return () => {
      isMounted = false;
      dbCleanup?.();
      window.removeEventListener("pp-database-switched", handleDatabaseSwitched);
      window.removeEventListener("pp-leaders-changed", handleLeadersChanged);
    };
  }, [settings?.selectedLeader]); // Only depend on settings, not user - we handle user change via pp-database-switched event

  // Sync leader name to backend when selectedLeader changes (for UDP offer - C# uses cmbLeader.Text)
  useEffect(() => {
    syncLeaderNameToBackend(selectedLeader?.name ?? "");
  }, [selectedLeader]);

  const setSelectedLeaderId = useCallback(
    (leaderId: string | null) => {
      if (leaderId) {
        const db = Database.getInstance();
        const leaders = db.getAllLeaders();
        const leader = leaders.find((l) => l.id === leaderId);
        setSelectedLeader(leader || null);
        updateSettingWithAutoSave("selectedLeader", leaderId);
      } else {
        setSelectedLeader(null);
        updateSettingWithAutoSave("selectedLeader", undefined);
      }
    },
    [updateSettingWithAutoSave]
  );

  return <LeaderContext.Provider value={{ selectedLeader, setSelectedLeaderId, allLeaders, guestLeaderId }}>{children}</LeaderContext.Provider>;
};
