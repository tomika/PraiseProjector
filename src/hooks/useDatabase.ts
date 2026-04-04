import { useState, useEffect } from "react";
import { Leaders } from "../../db-common";
import { Database } from "../../db-common/Database";

// Hook for managing leaders in the database (matching C# SettingsForm pattern)
export const useDatabase = () => {
  const [leaders, setLeaders] = useState<Leaders>(new Leaders());
  const [initialLeaders, setInitialLeaders] = useState<Leaders>(new Leaders());

  // Load leaders clone from database on mount (matching C# LoadSettings)
  useEffect(() => {
    let dbCleanup: (() => void) | undefined;
    let isMounted = true;

    const loadLeaders = async () => {
      const db = await Database.waitForReady();
      if (!isMounted) return;
      const leadersClone = db.createLeadersClone(); // Matching C# leaders = database.CreateLeadersClone()
      setLeaders(leadersClone);
      setInitialLeaders(leadersClone.clone());
    };

    const subscribeToDb = async () => {
      const db = await Database.waitForReady();
      if (!isMounted) return;
      db.emitter.on("db-updated", loadLeaders);
      dbCleanup = () => {
        db.emitter.off("db-updated", loadLeaders);
      };
    };

    const handleDatabaseSwitched = () => {
      dbCleanup?.();
      dbCleanup = undefined;
      subscribeToDb();
      loadLeaders();
    };

    loadLeaders();
    subscribeToDb();

    window.addEventListener("pp-database-switched", handleDatabaseSwitched);
    window.addEventListener("pp-leaders-changed", loadLeaders);

    return () => {
      isMounted = false;
      dbCleanup?.();
      window.removeEventListener("pp-database-switched", handleDatabaseSwitched);
      window.removeEventListener("pp-leaders-changed", loadLeaders);
    };
  }, []);

  // Save leaders back to database (matching C# OnOK button)
  const saveLeaders = async (nextLeaders?: Leaders): Promise<void> => {
    const db = Database.getInstance();
    const leadersToSave = nextLeaders ?? leaders;
    // Apply changes back to the database leaders
    // Remove all existing leaders
    const existingLeaders = [...db.leaders.items];
    for (const leader of existingLeaders) {
      db.leaders.remove(leader);
    }
    // Add all leaders from the clone
    for (const leader of leadersToSave.items) {
      db.leaders.add(leader);
    }
    setInitialLeaders(leadersToSave.clone());
    // Save to persist changes - use forceSaveAsync to properly wait
    await db.forceSaveAsync();
    // Emit db-updated is already done by forceSaveAsync, but also dispatch a global event
    // to ensure all components (including LeaderContext) refresh
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pp-leaders-changed"));
    }
  };

  // Revert to initial state (matching C# OnCancel button)
  const revertLeaders = () => {
    setLeaders(initialLeaders.clone());
  };

  return { leaders, setLeaders, saveLeaders, revertLeaders };
};
