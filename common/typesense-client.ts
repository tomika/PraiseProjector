import { Client } from "typesense";
import { CollectionCreateSchema } from "typesense/lib/Typesense/Collections";
import { SearchResponseHit } from "typesense/lib/Typesense/Documents";
import { log, logError } from "./pp-log";
import { SongFoundInfo, SongFoundType } from "./pp-types";

const schema: CollectionCreateSchema = {
  name: "ppsongs",
  fields: [
    { name: "created", type: "float", optional: true, index: false },
    { name: "uploader", type: "string", optional: true, index: false },
    { name: "owner", type: "string", optional: true, index: false },
    { name: "headEndPos", type: "float", optional: true, index: false },
    { name: ".*", type: "string", index: true },
  ],
};

type DocumentType = {
  songId: string;
  version: number;
  title: string;
  created: number;
  uploader: string;
  owner: string;
  lyrics: string;
  headEndPos: number;
  meta: { [key: string]: string | number };
};

export type SongInfo = {
  id: string;
  version: number;
  text: string;
  created?: Date;
  uploader?: string;
  owner?: string;
};

export class TypesenseClient {
  private client: Client;
  private initialized = false;
  private metaFields = new Set<string>();
  private metaFieldList = "";
  private queryWeights = "3,2";

  constructor(host: string, port: number, protocol: string, apiKey: string) {
    this.client = new Client({
      apiKey,
      nodes: [{ host, port, protocol }],
    });
  }

  async healthCheck(): Promise<boolean> {
    const health = await this.client.health.retrieve();
    return !!health.ok;
  }

  async update(songsToIndex: SongInfo[], selfCheck: boolean = false) {
    if (!this.initialized) {
      this.metaFields = new Set();

      try {
        await this.client.collections(schema.name).delete();
      } catch (e) {
        logError(`Error deleting schema '${schema.name}'`, e);
      }
      await this.client.collections().create(schema);
      this.initialized = true;
    }

    const songs = songsToIndex.map((r) => {
      const meta: { [key: string]: string } = {};
      const lyrics = r.text
        .replace(/^[ \t]*#.*$|\[[^\]]*\]|^[ \t]*{([^:}]+):?(.*)}[ \t]*$/gm, (_g: string, k: string, v: string) => {
          const key = k?.trim().toLowerCase(),
            value = v?.trim();
          if (key && value) {
            meta[key] = value;
            if (key !== "title" && !key.startsWith("start_")) this.metaFields.add(key);
          }
          return "";
        })
        .replace(/{start_of_grid.*?{end_of_grid}/gs, "")
        .trim();
      let headEndPos = 0;
      for (let j = 0; j < 2; ++j) {
        const endPos = lyrics.indexOf("\n", headEndPos + 1);
        if (endPos >= 0) headEndPos = endPos;
      }
      return {
        songId: r.id,
        version: parseInt(r.version.toString()),
        title: meta.title ?? "",
        lyrics,
        headEndPos,
        ...meta,
        created: r.created ? r.created.getTime() : 0,
        uploader: r.uploader ?? "",
        owner: r.owner ?? "",
      };
    });

    const results = await this.client.collections(schema.name).documents().import(songs, { action: "upsert" });
    for (const res of results) if (res.success === false) logError(`Error indexing song '${res.document?.songId}'`, res.error);
    log("Typesense index updated");

    const metaFieldArray = Array.from(this.metaFields);
    this.queryWeights = "3,2";
    if (metaFieldArray.length > 0) {
      this.metaFieldList = "," + metaFieldArray.join(",");
      for (let p = 0, l = this.metaFields.size; p < l; ++p) this.queryWeights += ",1";
    } else this.metaFieldList = "";

    if (selfCheck) {
      log("Starting selfcheck...");
      for (const song of songs) {
        if (song.title) {
          const res = await this.search(song.title);
          const ok = res.find((x) => x.songId === song.songId && x.version.toString() === song.version.toString());
          if (!ok) {
            log("SelfCheck Error: Newly registered song not found in typesense: " + song.songId + "(" + song.title + ")");
          }
        }
      }
      log("Selfcheck done.");
    }
  }

  async search(query: string, limit?: number): Promise<(SongFoundInfo & { version: number })[]> {
    const searchParameters = {
      q: query,
      query_by: "title,lyrics" + this.metaFieldList,
      prioritize_token_position: true,
      limit_hits: limit,
      per_page: limit,
      query_by_weights: this.queryWeights,
      order_by: "_text_match:desc",
    };
    const res = await this.client.collections<DocumentType>(schema.name).documents().search(searchParameters);
    const decodeType = (document: DocumentType, fieldName: string, matches: string[] | string[][]): SongFoundType => {
      switch (fieldName) {
        case "title":
          return "TITLE";
        case "lyrics":
          for (const m of matches) if (typeof m === "string" && document.lyrics.indexOf(m) < document.headEndPos) return "HEAD";
          return "LYRICS";
        default:
          return "META";
      }
    };
    const typeCost = (type: SongFoundType) => {
      switch (type) {
        case "TITLE":
          return 0;
        case "HEAD":
          return 1;
        case "LYRICS":
          return 2;
        case "META":
          return 3;
        default:
          return 4;
      }
    };
    const processHit = (hit: SearchResponseHit<DocumentType>, baseCost: number) => {
      const found: { type: SongFoundType; cost: number; snippet?: string } = {
        type: "LYRICS",
        cost: baseCost,
      };
      let bestHighlight, bestHighlightType;
      let bestHighlightCost = Number.MAX_VALUE;
      for (const highlight of hit.highlights ?? []) {
        const type = decodeType(hit.document, highlight.field, highlight.matched_tokens);
        const tc = typeCost(type) * 1000 + baseCost;
        if (bestHighlightCost === Number.MAX_VALUE || tc < bestHighlightCost) {
          bestHighlightType = type;
          bestHighlightCost = tc;
          bestHighlight = highlight;
        }
      }
      if (bestHighlight && bestHighlightType) {
        found.cost += bestHighlightCost;
        found.type = bestHighlightType;
        found.snippet = bestHighlight.snippet;
        if (found.snippet) {
          const firstMark = found.snippet.indexOf("<mark>");
          const lastMark = found.snippet.lastIndexOf("</mark>");
          const prevNL = found.snippet.lastIndexOf("\n", firstMark);
          const nextNL = found.snippet.indexOf("\n", lastMark);
          if (nextNL >= 0) found.snippet = found.snippet.substring(0, Math.min(nextNL, lastMark + 32));
          if (prevNL >= 0) found.snippet = found.snippet.substring(Math.max(prevNL, firstMark - 25));
          found.snippet = found.snippet.trim();
        }
        if (found.type === "META") found.snippet = bestHighlight.field + ":" + found.snippet;
      }
      return found;
    };
    let baseCost = 0;
    const formatDate = (value: number) => {
      try {
        return value && !isNaN(value) ? new Date(value).toISOString() : "";
      } catch (error) {
        logError("Problematic date value: " + value + " type: " + typeof value, error);
        return "";
      }
    };
    return (res.hits ?? [])
      .map((hit) => ({
        songId: hit.document.songId,
        version: hit.document.version,
        title: hit.document.title,
        found: processHit(hit, ++baseCost),
        created: formatDate(hit.document.created),
        owner: hit.document.owner,
        uploader: hit.document.uploader,
      }))
      .filter((x) => x.title)
      .sort((a, b) => {
        const cdiff = a.found.cost - b.found.cost;
        return cdiff || a.title.localeCompare(b.title);
      });
  }
}
