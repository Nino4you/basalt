import { expect, it } from "vitest";
import { installDomCompat } from "../../src/compat/obsidian-api";

it("creates real SVG nodes, nested shapes and attributes before attaching them", () => {
  installDomCompat();
  expect(typeof globalThis.createSvg).toBe("function");
  const parent = document.createElement("div");
  parent.append(document.createElement("span"));
  let detached = false;
  const svg = createSvg("svg", {
    cls: ["first second", "third"], parent, prepend: true,
    attr: { viewBox: "0 0 24 24", "aria-hidden": true, width: 24, omitted: null },
  }, (node) => { detached = node.parentNode === null; });
  expect(detached).toBe(true);
  expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(parent.firstChild).toBe(svg);
  expect(svg.getAttribute("class")).toBe("first second third");
  expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(svg.getAttribute("aria-hidden")).toBe("true");
  expect(svg.getAttribute("width")).toBe("24");
  expect(svg.hasAttribute("omitted")).toBe(false);
  const circle = svg.createSvg("circle", "shape filled", (node) => node.setAttribute("r", "4"));
  expect(circle.namespaceURI).toBe(svg.namespaceURI);
  expect(circle.parentNode).toBe(svg);
  expect(circle.getAttribute("class")).toBe("shape filled");
  expect(circle.getAttribute("r")).toBe("4");
  const fragment = document.createDocumentFragment();
  expect(fragment.createSvg("path", { attr: { d: "M0 0L1 1" } }).parentNode).toBe(fragment);
  expect(createSvg("svg").parentNode).toBeNull();
  installDomCompat();
  expect(parent.createSvg("svg").parentNode).toBe(parent);
});
