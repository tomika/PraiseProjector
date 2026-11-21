import { McpToolError } from "./types";

export function invalidArgument(message: string, field: string, index?: number): McpToolError {
  return new McpToolError(index === undefined ? message : `Item at index ${index}: ${message}`, "INVALID_ARGUMENT", {
    field,
    ...(index === undefined ? {} : { index }),
  });
}

export function strictObject(value: unknown, allowedKeys: readonly string[], field = "arguments", index?: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArgument(`'${field}' must be an object.`, field, index);
  const args = value as Record<string, unknown>;
  for (const [key, member] of Object.entries(args)) {
    if (!allowedKeys.includes(key)) {
      throw invalidArgument(`Unsupported field '${key}'. Allowed fields: ${allowedKeys.join(", ")}.`, key, index);
    }
    if (member === null) throw invalidArgument(`'${key}' cannot be null; omit it to use the default if it is optional.`, key, index);
  }
  return args;
}

export function validateArgument<T>(field: string, read: () => T, index?: number): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof McpToolError && !error.code) throw invalidArgument(error.message, field, index);
    throw error;
  }
}
