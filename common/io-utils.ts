import * as t from "io-ts";
import { isRight } from "fp-ts/lib/Either";

function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

function summarizeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return `string("${truncateText(value, 40)}")`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return `${typeof value}(${String(value)})`;
  if (typeof value === "symbol") return "symbol";
  if (typeof value === "function") return "function";
  if (value instanceof Date) return `Date(${isNaN(value.getTime()) ? "invalid" : value.toISOString()})`;
  if (Array.isArray(value)) return `array(length ${value.length})`;
  if (typeof value === "object") return "object";
  return typeof value;
}

function getErrorPath(error: t.ValidationError): string {
  const path = error.context
    .slice(1)
    .map((entry) => entry.key)
    .filter((key) => key.length > 0)
    .join(".");
  return path || "value";
}

function getExpectedType(error: t.ValidationError): string {
  const typeName = error.context[error.context.length - 1]?.type?.name || "valid value";
  return truncateText(typeName.replace(/\s+/g, " "), 80);
}

export function formatIoTsErrors(errors: t.Errors, maxIssues = 5): string {
  const grouped = new Map<
    string,
    {
      path: string;
      actual: string;
      expected: Set<string>;
      message?: string;
    }
  >();

  for (const error of errors) {
    const path = getErrorPath(error);
    const actual = summarizeValue(error.value);
    const groupKey = `${path}::${actual}`;
    const existing = grouped.get(groupKey) ?? {
      path,
      actual,
      expected: new Set<string>(),
      message: error.message,
    };

    existing.expected.add(getExpectedType(error));
    if (!existing.message && error.message) {
      existing.message = error.message;
    }
    grouped.set(groupKey, existing);
  }

  let issues = Array.from(grouped.values());
  if (issues.some((issue) => issue.path !== "value")) {
    issues = issues.filter((issue) => issue.path !== "value");
  }

  const lines = issues.slice(0, maxIssues).map((issue) => {
    if (issue.message) {
      return `${issue.path}: ${issue.message}`;
    }
    const expected = Array.from(issue.expected).sort().join(" or ");
    return `${issue.path}: expected ${expected}, got ${issue.actual}`;
  });

  const remaining = issues.length - lines.length;
  if (remaining > 0) {
    lines.push(`...and ${remaining} more validation ${remaining === 1 ? "issue" : "issues"}`);
  }

  return lines.join("\n");
}

export function decode<T, O, I>(codec: t.Type<T, O, I>, value: I): T {
  const validation = codec.decode(value);
  if (isRight(validation)) {
    return validation.right;
  } else {
    throw new Error(formatIoTsErrors(validation.left));
  }
}

export function parseAndDecode<T, O, I>(codec: t.Type<T, O, I>, jsonString: string): T {
  let json: unknown;
  try {
    json = JSON.parse(jsonString);
  } catch (e) {
    throw new Error(`Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return decode(codec, json as I);
}
