export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFunction = (message: string, level: LogLevel) => void;

export let logFunc: LogFunction = (message: string, level: LogLevel) => {
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else if (level === "debug") console.debug(message);
  else console.info(message);
};

export function setLogFunction(func: LogFunction) {
  logFunc = func;
}

export function log(message: string, level: LogLevel = "info") {
  logFunc(message, level);
}

export function logError(message: string, error: unknown) {
  let formatted = message + "\n";
  if (error instanceof Error) {
    formatted += "Message: " + error.message;
    if (error.stack) formatted += "\nCallstack:\n" + error.stack;
  } else {
    const typename = typeof error === "object" && error != null ? error.constructor?.name : "";
    const prefix = typename ? typename + ": " : "";
    formatted += prefix + JSON.stringify(error);
  }
  logFunc(formatted, "error");
}
