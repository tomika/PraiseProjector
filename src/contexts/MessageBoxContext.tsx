import React, { createContext, useContext, ReactNode, useCallback, useRef } from "react";

export interface ConfirmOptions {
  confirmText?: string;
  confirmDanger?: boolean;
}

interface MessageBoxContextType {
  showMessage: (title: string, message: string, onConfirm?: () => void) => void;
  showConfirm: (title: string, message: string, onConfirm: () => void, onCancel?: () => void, options?: ConfirmOptions) => void;
  /** Promise-returning version of showConfirm for async/await usage */
  showConfirmAsync: (title: string, message: string, options?: ConfirmOptions) => Promise<boolean>;
  /** 3-button dialog returning "yes", "no", or "cancel" */
  showYesNoCancelAsync: (title: string, message: string, options?: ConfirmOptions) => Promise<"yes" | "no" | "cancel">;
}

const MessageBoxContext = createContext<MessageBoxContextType | undefined>(undefined);

export const useMessageBox = () => {
  const context = useContext(MessageBoxContext);
  if (!context) {
    throw new Error("useMessageBox must be used within a MessageBoxProvider");
  }
  return context;
};

export interface MessageBoxConfig {
  title: string;
  message: string;
  onConfirm: () => void;
  onNo?: () => void;
  onCancel?: () => void;
  // When false the Cancel button will NOT be shown (OK-only dialog)
  showCancel?: boolean;
  /** Custom text for the confirm/OK button */
  confirmText?: string;
  /** When true the confirm button will be styled as a danger (red) button */
  confirmDanger?: boolean;
}

interface MessageBoxProviderProps {
  children: ReactNode;
  onMessageBoxChange: (config: MessageBoxConfig | null) => void;
}

export const MessageBoxProvider: React.FC<MessageBoxProviderProps> = ({ children, onMessageBoxChange }) => {
  // FIFO queue of pending dialogs. Only the head is displayed. A new request
  // while a dialog is visible is queued, never replaces the visible one —
  // otherwise the replaced dialog's question (and pending promise) is lost.
  const queueRef = useRef<MessageBoxConfig[]>([]);
  const activeRef = useRef(false);

  const showNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (next) {
      activeRef.current = true;
      onMessageBoxChange(next);
    } else {
      activeRef.current = false;
      onMessageBoxChange(null);
    }
  }, [onMessageBoxChange]);

  const enqueue = useCallback(
    (config: MessageBoxConfig) => {
      queueRef.current.push(config);
      if (!activeRef.current) {
        showNext();
      }
    },
    [showNext]
  );

  const showMessage = useCallback(
    (title: string, message: string, onConfirm?: () => void) => {
      enqueue({
        title,
        message,
        onConfirm: () => {
          // Advance the queue first so a dialog shown by the callback is
          // queued normally and the queue can never stall on a throwing callback.
          showNext();
          Promise.resolve(onConfirm?.()).catch((error) => {
            console.error("MessageBox", "onConfirm callback failed", error);
          });
        },
        showCancel: false,
      });
    },
    [enqueue, showNext]
  );

  const showConfirm = useCallback(
    (title: string, message: string, onConfirm: () => void, onCancel?: () => void, options?: ConfirmOptions) => {
      enqueue({
        title,
        message,
        onConfirm: () => {
          // Advance first so any later dialogs triggered by async work
          // (e.g. save errors) are queued normally instead of being cleared.
          showNext();
          Promise.resolve(onConfirm()).catch((error) => {
            console.error("MessageBox", "onConfirm callback failed", error);
          });
        },
        onCancel: () => {
          showNext();
          Promise.resolve(onCancel?.()).catch((error) => {
            console.error("MessageBox", "onCancel callback failed", error);
          });
        },
        showCancel: true,
        confirmText: options?.confirmText,
        confirmDanger: options?.confirmDanger,
      });
    },
    [enqueue, showNext]
  );

  const showConfirmAsync = useCallback(
    (title: string, message: string, options?: ConfirmOptions): Promise<boolean> => {
      return new Promise((resolve) => {
        enqueue({
          title,
          message,
          onConfirm: () => {
            showNext();
            resolve(true);
          },
          onCancel: () => {
            showNext();
            resolve(false);
          },
          showCancel: true,
          confirmText: options?.confirmText,
          confirmDanger: options?.confirmDanger,
        });
      });
    },
    [enqueue, showNext]
  );

  const showYesNoCancelAsync = useCallback(
    (title: string, message: string, options?: ConfirmOptions): Promise<"yes" | "no" | "cancel"> => {
      return new Promise((resolve) => {
        enqueue({
          title,
          message,
          onConfirm: () => {
            showNext();
            resolve("yes");
          },
          onNo: () => {
            showNext();
            resolve("no");
          },
          onCancel: () => {
            showNext();
            resolve("cancel");
          },
          showCancel: true,
          confirmText: options?.confirmText,
          confirmDanger: options?.confirmDanger,
        });
      });
    },
    [enqueue, showNext]
  );

  return (
    <MessageBoxContext.Provider value={{ showMessage, showConfirm, showConfirmAsync, showYesNoCancelAsync }}>{children}</MessageBoxContext.Provider>
  );
};
