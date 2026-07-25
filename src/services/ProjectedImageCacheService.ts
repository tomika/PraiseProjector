type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const MAX_PROJECTED_IMAGE_ENTRIES = 20;

function stableStringify(value: JsonValue): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number" || t === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((x) => stableStringify(x)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${stableStringify((value as { [key: string]: JsonValue })[key])}`);
  }
  return `{${parts.join(",")}}`;
}

function estimatedStringBytes(value: string): number {
  return value.length * 2;
}

function trimCache(cache: Map<string, string>, maxEstimatedBytes: number): void {
  let estimatedBytes = 0;
  for (const value of cache.values()) estimatedBytes += estimatedStringBytes(value);
  while (cache.size > MAX_PROJECTED_IMAGE_ENTRIES || estimatedBytes > maxEstimatedBytes) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    estimatedBytes -= estimatedStringBytes(cache.get(firstKey) ?? "");
    cache.delete(firstKey);
  }
}

interface ProjectedImageCacheKeyInput {
  text: string;
  renderSettingsSnapshot: JsonValue;
  backgroundSignature: string;
}

class ProjectedImageCacheService {
  private readonly cache = new Map<string, string>();

  private touch(key: string): string | undefined {
    const value = this.cache.get(key);
    if (value === undefined) return undefined;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  buildCacheKey(input: ProjectedImageCacheKeyInput): string {
    return stableStringify({
      text: input.text,
      render: input.renderSettingsSnapshot,
      background: input.backgroundSignature,
    });
  }

  getOrCreate(cacheKey: string, producer: () => string, maxEstimatedBytes: number): string {
    if (maxEstimatedBytes <= 0) return producer();
    const cached = this.touch(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const created = producer();
    this.cache.set(cacheKey, created);
    trimCache(this.cache, maxEstimatedBytes);
    return created;
  }

  clear(): void {
    this.cache.clear();
  }
}

export const projectedImageCacheService = new ProjectedImageCacheService();
