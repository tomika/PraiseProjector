/**
 * Render-neutral drawing surface for guitar/piano chord diagrams.
 *
 * The chord-diagram geometry (`ChordDrawer.drawGuitarChordLayout` /
 * `drawPianoChordLayout` and the shared `drawChordText`) used to talk to a
 * `CanvasRenderingContext2D` directly, so the ONLY way to display a diagram was
 * to rasterize it into a fixed-size `<canvas>`. On the DOM song surface that
 * canvas is then blown up by the fit-to-screen `transform: scale()`, and a
 * raster bitmap upsampled by a large factor is blurry.
 *
 * This is the diagram analogue of `chord-visual.ts`: the geometry now issues
 * primitive draw calls against a small `DiagramSurface` port, and two adapters
 * consume the identical call stream —
 *   • `CanvasDiagramSurface` forwards 1:1 to a 2D context (the interactive chord
 *     selector, the importer preview and the legacy client keep pixel-identical
 *     canvas output);
 *   • `SvgDiagramSurface` emits `<line>/<rect>/<circle>/<text>` into an `<svg>`,
 *     which is resolution-independent and stays razor-sharp under any ancestor
 *     `transform: scale()`.
 *
 * The two adapters MUST produce the same layout, so both measure text the same
 * way: the canvas adapter via its own `ctx.measureText`, the SVG adapter via a
 * shared offscreen 2D context using the same font string. Geometry is therefore
 * decided in exactly one place; only the paint backend differs.
 */

/** The subset of `TextMetrics` the diagram geometry reads. */
export interface TextMetricsLike {
  readonly width: number;
}

/**
 * The exact subset of `CanvasRenderingContext2D` the chord-diagram geometry
 * uses, plus three shape helpers (`fillCircle`/`strokeCircle`/`strokeLine`) that
 * replace the raw `beginPath`/`arc`/`moveTo`/`lineTo` sequences so an adapter
 * need not model canvas paths. Colors are plain CSS color strings.
 */
export interface DiagramSurface {
  /** Snapshot `fillStyle`/`strokeStyle`/`font` (like canvas `save()`). */
  save(): void;
  /** Restore the last snapshot (like canvas `restore()`). */
  restore(): void;
  strokeStyle: string;
  fillStyle: string;
  font: string;
  measureText(text: string): TextMetricsLike;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  /** Fills text with `fillStyle`/`font`; `(x, y)` is the alphabetic baseline. */
  fillText(text: string, x: number, y: number): void;
  fillCircle(cx: number, cy: number, radius: number): void;
  strokeCircle(cx: number, cy: number, radius: number): void;
  strokeLine(x1: number, y1: number, x2: number, y2: number): void;
}

/** Forwards every call straight to a 2D context — canvas output is unchanged. */
export class CanvasDiagramSurface implements DiagramSurface {
  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  save() {
    this.ctx.save();
  }
  restore() {
    this.ctx.restore();
  }
  get strokeStyle() {
    return this.ctx.strokeStyle as string;
  }
  set strokeStyle(value: string) {
    this.ctx.strokeStyle = value;
  }
  get fillStyle() {
    return this.ctx.fillStyle as string;
  }
  set fillStyle(value: string) {
    this.ctx.fillStyle = value;
  }
  get font() {
    return this.ctx.font;
  }
  set font(value: string) {
    this.ctx.font = value;
  }
  measureText(text: string): TextMetricsLike {
    return this.ctx.measureText(text);
  }
  fillRect(x: number, y: number, width: number, height: number) {
    this.ctx.fillRect(x, y, width, height);
  }
  strokeRect(x: number, y: number, width: number, height: number) {
    this.ctx.strokeRect(x, y, width, height);
  }
  fillText(text: string, x: number, y: number) {
    this.ctx.fillText(text, x, y);
  }
  fillCircle(cx: number, cy: number, radius: number) {
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    this.ctx.fill();
  }
  strokeCircle(cx: number, cy: number, radius: number) {
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    this.ctx.stroke();
  }
  strokeLine(x1: number, y1: number, x2: number, y2: number) {
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.stroke();
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Shared offscreen 2D context used ONLY to measure text for the SVG adapter, so
 * an SVG diagram lays out identically to a canvas one. Lazily created; null in a
 * non-DOM context (a fallback estimate is used then).
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  }
  return measureCtx;
}

/**
 * Emits the diagram as child elements of a given `<svg>` root. The caller sets
 * the root's `viewBox` to the diagram's natural size so 1 SVG unit == 1 nominal
 * px; scaling is then the browser's job and stays sharp at any factor.
 */
export class SvgDiagramSurface implements DiagramSurface {
  strokeStyle = "black";
  fillStyle = "black";
  font = "10px sans-serif";
  private readonly doc: Document;
  private readonly stack: { strokeStyle: string; fillStyle: string; font: string }[] = [];

  /**
   * @param svg  Root the primitives are appended to (already cleared and sized).
   * @param background  Optional opaque backdrop filling the whole diagram box
   *   before drawing. Omit for transparent.
   */
  constructor(
    private readonly svg: SVGSVGElement,
    background?: string
  ) {
    this.doc = svg.ownerDocument;
    if (background) {
      const bg = this.el("rect");
      bg.setAttribute("x", "0");
      bg.setAttribute("y", "0");
      bg.setAttribute("width", "100%");
      bg.setAttribute("height", "100%");
      bg.setAttribute("fill", background);
      this.svg.appendChild(bg);
    }
  }

  private el(name: string) {
    return this.doc.createElementNS(SVG_NS, name);
  }

  save() {
    this.stack.push({ strokeStyle: this.strokeStyle, fillStyle: this.fillStyle, font: this.font });
  }
  restore() {
    const snapshot = this.stack.pop();
    if (snapshot) {
      this.strokeStyle = snapshot.strokeStyle;
      this.fillStyle = snapshot.fillStyle;
      this.font = snapshot.font;
    }
  }
  measureText(text: string): TextMetricsLike {
    const ctx = getMeasureCtx();
    if (!ctx) return { width: text.length * 6 };
    ctx.font = this.font;
    return { width: ctx.measureText(text).width };
  }
  fillRect(x: number, y: number, width: number, height: number) {
    const rect = this.el("rect");
    rect.setAttribute("x", `${x}`);
    rect.setAttribute("y", `${y}`);
    rect.setAttribute("width", `${width}`);
    rect.setAttribute("height", `${height}`);
    rect.setAttribute("fill", this.fillStyle);
    this.svg.appendChild(rect);
  }
  strokeRect(x: number, y: number, width: number, height: number) {
    const rect = this.el("rect");
    rect.setAttribute("x", `${x}`);
    rect.setAttribute("y", `${y}`);
    rect.setAttribute("width", `${width}`);
    rect.setAttribute("height", `${height}`);
    rect.setAttribute("fill", "none");
    rect.setAttribute("stroke", this.strokeStyle);
    rect.setAttribute("stroke-width", "1");
    this.svg.appendChild(rect);
  }
  fillText(text: string, x: number, y: number) {
    const node = this.el("text") as SVGTextElement;
    node.setAttribute("x", `${x}`);
    node.setAttribute("y", `${y}`);
    node.setAttribute("fill", this.fillStyle);
    // Canvas defaults: textAlign "start" (SVG text-anchor default) and
    // textBaseline "alphabetic" — pin the baseline so output does not depend
    // on the UA's dominant-baseline default.
    node.setAttribute("dominant-baseline", "alphabetic");
    node.style.font = this.font;
    node.style.whiteSpace = "pre";
    node.textContent = text;
    this.svg.appendChild(node);
  }
  fillCircle(cx: number, cy: number, radius: number) {
    const circle = this.el("circle");
    circle.setAttribute("cx", `${cx}`);
    circle.setAttribute("cy", `${cy}`);
    circle.setAttribute("r", `${radius}`);
    circle.setAttribute("fill", this.fillStyle);
    this.svg.appendChild(circle);
  }
  strokeCircle(cx: number, cy: number, radius: number) {
    const circle = this.el("circle");
    circle.setAttribute("cx", `${cx}`);
    circle.setAttribute("cy", `${cy}`);
    circle.setAttribute("r", `${radius}`);
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", this.strokeStyle);
    circle.setAttribute("stroke-width", "1");
    this.svg.appendChild(circle);
  }
  strokeLine(x1: number, y1: number, x2: number, y2: number) {
    const line = this.el("line");
    line.setAttribute("x1", `${x1}`);
    line.setAttribute("y1", `${y1}`);
    line.setAttribute("x2", `${x2}`);
    line.setAttribute("y2", `${y2}`);
    line.setAttribute("stroke", this.strokeStyle);
    line.setAttribute("stroke-width", "1");
    this.svg.appendChild(line);
  }
}
