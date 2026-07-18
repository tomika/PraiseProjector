import { CHORDFORMAT_SUBSCRIPT } from "./chord-visual";
import { createMeasurementTextNode, createTagNode } from "./dom-nodes";
import { buildMeasurementCacheKey, type MeasuredSize, type MeasurementRequest, type MeasurementResult, type TextMeasurer } from "./text-measurer";

export interface TagMeasurementRequest {
  readonly id: string;
  readonly text: string;
  readonly font: string;
  readonly color?: string;
}

export interface TagMeasurementResult {
  readonly id: string;
  readonly size: MeasuredSize;
}

type MeasuredNode = { node: HTMLElement; size?: MeasuredSize };

/** Batched DOM measurer using the same safe node factories as the visible renderer. */
export class DomTextMeasurer implements TextMeasurer {
  private readonly root: HTMLDivElement;
  private readonly cache = new Map<string, MeasuredSize>();
  private revision = 0;
  private semanticStyleRevision = 0;
  private disposed = false;
  private rootFontSize = "";
  private readonly fontSet: FontFaceSet | null;
  private readonly handleFontEvent = () => {
    this.invalidate();
    this.onMetricsInvalidated?.();
  };

  constructor(
    private readonly doc: Document,
    private readonly onMetricsInvalidated?: () => void
  ) {
    this.root = doc.createElement("div");
    this.root.className = "chp-dom-measure-root";
    this.root.setAttribute("aria-hidden", "true");
    (doc.body || doc.documentElement).appendChild(this.root);
    this.fontSet = doc.fonts ?? null;
    this.fontSet?.addEventListener("loading", this.handleFontEvent);
    this.fontSet?.addEventListener("loadingdone", this.handleFontEvent);
    this.fontSet?.addEventListener("loadingerror", this.handleFontEvent);
    void this.fontSet?.ready.then(() => {
      if (!this.disposed) this.handleFontEvent();
    });
    this.captureRootFontSize();
  }

  get styleRevision() {
    return this.revision;
  }

  get fontsPending() {
    return this.fontSet?.status === "loading";
  }

  setStyleRevision(revision: number) {
    if (this.semanticStyleRevision === revision) return;
    this.semanticStyleRevision = revision;
    this.revision += 1;
    this.cache.clear();
    this.captureRootFontSize();
  }

  invalidate() {
    this.revision += 1;
    this.cache.clear();
    this.captureRootFontSize();
  }

  measure(requests: readonly MeasurementRequest[]): readonly MeasurementResult[] {
    this.ensureUsable();
    this.invalidateForRootFontChange();
    const measured = this.measureUnique(
      requests.map((request) => ({
        id: request.id,
        key: buildMeasurementCacheKey(request, this.revision),
        create: () => {
          const subscript =
            (request.chordFormat ?? 0) & CHORDFORMAT_SUBSCRIPT ? request.role === "modifier" || request.role === "bass-modifier" : false;
          return createMeasurementTextNode(this.doc, request.text, request.role, { font: request.font }, subscript);
        },
      }))
    );
    return requests.map((request, index) => ({ id: request.id, size: measured[index] }));
  }

  measureTags(requests: readonly TagMeasurementRequest[]): readonly TagMeasurementResult[] {
    this.ensureUsable();
    this.invalidateForRootFontChange();
    const measured = this.measureUnique(
      requests.map((request) => ({
        id: request.id,
        key: JSON.stringify(["tag", request.font, request.color ?? "", request.text, this.revision]),
        create: () => createTagNode(this.doc, request.text, { font: request.font, color: request.color }),
      }))
    );
    return requests.map((request, index) => ({ id: request.id, size: measured[index] }));
  }

  /**
   * Measures a caller-owned element inside the hidden measurement root and hands
   * it back detached. Used for content the renderer owns but cannot express as a
   * text request — currently the ABC containers, whose geometry is produced by
   * the ABC library rather than by font metrics. Deliberately uncached: the
   * caller owns the element's identity and its own invalidation key.
   */
  measureOwnedElement(node: HTMLElement): MeasuredSize {
    this.ensureUsable();
    this.root.appendChild(node);
    const rect = node.getBoundingClientRect();
    node.remove();
    return { width: rect.width, height: rect.height };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.fontSet?.removeEventListener("loading", this.handleFontEvent);
    this.fontSet?.removeEventListener("loadingdone", this.handleFontEvent);
    this.fontSet?.removeEventListener("loadingerror", this.handleFontEvent);
    this.root.remove();
    this.cache.clear();
  }

  private measureUnique(requests: readonly { id: string; key: string; create: () => HTMLElement }[]): MeasuredSize[] {
    const pendingByKey = new Map<string, MeasuredNode>();
    const fragment = this.doc.createDocumentFragment();

    for (const request of requests) {
      if (this.cache.has(request.key) || pendingByKey.has(request.key)) continue;
      const node = request.create();
      pendingByKey.set(request.key, { node });
      fragment.appendChild(node);
    }

    // One DOM write for the entire unique request batch, followed by one read
    // phase over all nodes. Clearing happens once after every read completes.
    if (pendingByKey.size > 0) {
      this.root.appendChild(fragment);
      for (const [key, pending] of pendingByKey) {
        const rect = pending.node.getBoundingClientRect();
        const size = { width: rect.width, height: rect.height };
        pending.size = size;
        this.cache.set(key, size);
      }
      this.root.replaceChildren();
    }

    return requests.map((request) => this.cache.get(request.key) ?? { width: 0, height: 0 });
  }

  private captureRootFontSize() {
    this.rootFontSize = this.doc.defaultView?.getComputedStyle(this.doc.documentElement).fontSize ?? this.doc.documentElement.style.fontSize ?? "";
  }

  private invalidateForRootFontChange() {
    const current = this.doc.defaultView?.getComputedStyle(this.doc.documentElement).fontSize ?? this.doc.documentElement.style.fontSize ?? "";
    if (current !== this.rootFontSize) {
      this.revision += 1;
      this.cache.clear();
      this.rootFontSize = current;
    }
  }

  private ensureUsable() {
    if (this.disposed) throw new Error("DomTextMeasurer has been disposed");
  }
}
