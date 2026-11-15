export interface SvgElementInfo {
  cls?: string | string[];
  attr?: Record<string, string | number | boolean | null>;
  parent?: Node;
  prepend?: boolean;
}

declare global {
  function createSvg<K extends keyof SVGElementTagNameMap>(
    tag: K, options?: SvgElementInfo | string,
    callback?: (element: SVGElementTagNameMap[K]) => void,
  ): SVGElementTagNameMap[K];
  interface Node {
    createSvg<K extends keyof SVGElementTagNameMap>(
      tag: K, options?: SvgElementInfo | string,
      callback?: (element: SVGElementTagNameMap[K]) => void,
    ): SVGElementTagNameMap[K];
  }
}

function createSvg<K extends keyof SVGElementTagNameMap>(
  tag: K, options?: SvgElementInfo | string,
  callback?: (element: SVGElementTagNameMap[K]) => void,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  const info = typeof options === "string" ? { cls: options } : options;
  if (info?.cls) node.setAttribute("class", Array.isArray(info.cls) ? info.cls.join(" ") : info.cls);
  for (const [key, value] of Object.entries(info?.attr ?? {}))
    if (value !== null) node.setAttribute(key, String(value));
  callback?.(node);
  if (info?.parent)
    info.parent.insertBefore(node, info.prepend ? info.parent.firstChild : null);
  return node;
}

export function installSvgCompat(): void {
  globalThis.createSvg ??= createSvg;
  Node.prototype.createSvg ??= function (tag, options, callback) {
    return createSvg(tag, {
      ...(typeof options === "string" ? { cls: options } : options), parent: this,
    }, callback);
  };
}
