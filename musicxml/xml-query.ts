/** The small subset of jQuery used by xml2abc. XML names are case sensitive;
 * paths contain only element names separated by '>'. No browser CSS engine,
 * HTML parsing, global document or jQuery is needed (also works in a worker). */
type XmlNode = Document | Element;

function children(node: XmlNode): Element[] {
  return Array.from(node.childNodes).filter((n): n is Element => n.nodeType === 1);
}

class XmlQuery {
  [index: number]: XmlNode;
  readonly length: number;
  constructor(readonly nodes: XmlNode[] = []) {
    this.nodes = [...new Set(nodes)];
    this.length = this.nodes.length;
    this.nodes.forEach((n, i) => (this[i] = n));
  }
  find(path: string): XmlQuery {
    const [first, ...rest] = path.split(">");
    let nodes = this.nodes.flatMap((n) => Array.from(n.getElementsByTagName(first)));
    for (const tag of rest) nodes = nodes.flatMap((n) => children(n).filter((c) => c.tagName === tag));
    return new XmlQuery(nodes);
  }
  children(tag?: string): XmlQuery {
    return new XmlQuery(this.nodes.flatMap(children).filter((n) => !tag || n.tagName === tag));
  }
  attr(name: string, value?: string): string | undefined | XmlQuery {
    if (value !== undefined) {
      this.nodes.forEach((n) => (n as Element).setAttribute(name, value));
      return this;
    }
    const n = this.nodes[0] as Element | undefined;
    return n?.hasAttribute(name) ? (n.getAttribute(name) ?? undefined) : undefined;
  }
  text(): string {
    return this.nodes.map((n) => n.textContent ?? "").join("");
  }
  eq(i: number): XmlQuery {
    return new XmlQuery(this.nodes[i] ? [this.nodes[i]] : []);
  }
  first(): XmlQuery {
    return this.eq(0);
  }
  add(value: XmlQuery): XmlQuery {
    return new XmlQuery([...this.nodes, ...value.nodes]);
  }
  get(i?: number): XmlNode | XmlNode[] {
    return i === undefined ? this.nodes : this.nodes[i];
  }
  toArray(): XmlNode[] {
    return this.nodes.slice();
  }
  slice(i: number): XmlQuery {
    return new XmlQuery(this.nodes.slice(i));
  }
  each(callback: (this: XmlNode, i: number, node: XmlNode) => void): XmlQuery {
    this.nodes.forEach((n, i) => callback.call(n, i, n));
    return this;
  }
  map(callback: (this: XmlNode, i: number, node: XmlNode) => unknown): { get(): unknown[] } {
    return { get: () => this.nodes.map((n, i) => callback.call(n, i, n)) };
  }
  append(value: XmlQuery | XmlQuery[]): XmlQuery {
    for (const q of Array.isArray(value) ? value : [value]) for (const node of q.nodes) this.nodes[0].appendChild(node);
    return this;
  }
  splice(start: number, count: number, ...nodes: XmlNode[]): XmlNode[] {
    const result = this.nodes.splice(start, count, ...nodes);
    this.nodes.forEach((n, i) => (this[i] = n));
    return result;
  }
}

export function xmlQuery(value?: XmlNode | XmlNode[] | XmlQuery | string, owner?: Element): XmlQuery {
  if (value instanceof XmlQuery) return value;
  if (typeof value === "string") {
    // Only the upstream empty-staff repair creates elements. Its fragments are
    // simple <tag>text</tag>, including an upstream missing closing '>'.
    const match = /^<([\w-]+)>([^<]*)/.exec(value);
    if (!match || !owner?.ownerDocument) throw new Error("Invalid MusicXML element construction");
    const node = owner.ownerDocument.createElement(match[1]);
    if (match[2]) node.appendChild(owner.ownerDocument.createTextNode(match[2]));
    return new XmlQuery([node]);
  }
  return new XmlQuery(Array.isArray(value) ? value : value ? [value] : []);
}
