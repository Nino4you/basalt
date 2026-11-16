import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("mermaid");
  vi.doUnmock("katex");
  vi.resetModules();
  vi.restoreAllMocks();
});

it("leaves formulas editable and settles layout when the lazy renderer fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.doMock("katex", () => { throw new Error("Chunk unavailable"); });
  const { enhanceMath } = await import("../../src/app/rich-content");
  const root = document.createElement("div"); root.textContent = "$x$";
  const settled = vi.fn();
  enhanceMath(root, () => true, settled);
  await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
  expect(root.textContent).toBe("$x$");
});

it("ignores Mermaid completion after its owner becomes stale", async () => {
  let resolve!: (value: {svg:string}) => void;
  const render = vi.fn(() => new Promise<{svg:string}>(done => { resolve = done; }));
  vi.doMock("mermaid", () => ({default:{initialize:vi.fn(), render}}));
  const { enhanceMermaid } = await import("../../src/app/rich-content");
  const root = diagram("flowchart LR\n A --> B");
  let current = true;
  const settled = vi.fn();
  enhanceMermaid(root, () => current, settled);
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  current = false;
  resolve({svg:"<svg>stale</svg>"});
  await new Promise(done => setTimeout(done, 0));
  expect(root.querySelector("svg")).toBeNull();
  expect(settled).not.toHaveBeenCalled();
});

it("paints Mermaid with the current app theme on every render batch", async () => {
  const initialize = vi.fn();
  const render = vi.fn().mockResolvedValue({ svg: "<svg></svg>" });
  vi.doMock("mermaid", () => ({ default: { initialize, render } }));
  const { enhanceMermaid } = await import("../../src/app/rich-content");
  document.body.classList.add("theme-dark");
  enhanceMermaid(diagram("flowchart LR\n A --> B"), () => true);
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
  document.body.classList.remove("theme-dark");
  enhanceMermaid(diagram("flowchart LR\n A --> B"), () => true);
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
  const [dark, light] = initialize.mock.calls.map(([config]) => config);
  expect(dark).toMatchObject({
    theme: "base",
    darkMode: true,
    securityLevel: "strict",
  });
  expect(light).toMatchObject({ theme: "base", darkMode: false });
  // Mermaid derives shades itself and cannot read CSS variables.
  for (const [key, value] of Object.entries(light.themeVariables))
    if (/Color|Bkg|background|Border/.test(key))
      expect(value, key).toMatch(/^(rgba?\(|#)/);
  expect(light.themeVariables.primaryTextColor).toMatch(/^(rgb|#)/);
  expect(light.themeVariables.dropShadow).toBe("none");
});

function diagram(source: string): HTMLElement {
  const root = document.createElement("div");
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-mermaid";
  code.textContent = source;
  pre.append(code);
  root.append(pre);
  return root;
}

it("keeps every Mermaid source visible when its lazy chunk fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.doMock("mermaid", () => { throw new Error("Chunk unavailable"); });
  const { enhanceMermaid } = await import("../../src/app/rich-content");
  const source = "flowchart TD\n A[<script>not markup</script>] --> B";
  const first = diagram(source);
  const secondSource = "flowchart TD\n B --> C";
  first.append(diagram(secondSource));
  enhanceMermaid(first, () => true);
  await vi.waitFor(() => expect([...first.querySelectorAll(".mermaid-error")].map(el => el.textContent)).toEqual([source, secondSource]));
  expect(first.querySelector("script")).toBeNull();
});

it("preserves source when the Mermaid renderer rejects a malformed diagram", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.doMock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn().mockRejectedValue(new Error("Syntax error")) } }));
  const { enhanceMermaid } = await import("../../src/app/rich-content");
  const root = diagram("not a valid diagram");
  enhanceMermaid(root, () => true);
  await vi.waitFor(() => expect(root.querySelector(".mermaid-error")?.textContent).toBe("not a valid diagram"));
});

it("shares the lazy Mermaid instance between plugins and host diagrams", async () => {
  const mermaid = {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }),
  };
  vi.doMock("mermaid", () => ({ default: mermaid }));
  const { createObsidianApi } = await import("../../src/compat/obsidian-api");
  const { enhanceMermaid } = await import("../../src/app/rich-content");
  const load = createObsidianApi({ app: {} }).loadMermaid as () => Promise<unknown>;
  expect(typeof load).toBe("function");
  const first = load();
  expect(load()).toBe(first);
  expect(await first).toBe(mermaid);
  enhanceMermaid(diagram("flowchart LR\n A --> B"), () => true);
  await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
  expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict" }));
});

it("propagates Mermaid chunk failures to plugin callers", async () => {
  const failure = new Error("Chunk unavailable");
  vi.doMock("mermaid", () => { throw failure; });
  const { createObsidianApi } = await import("../../src/compat/obsidian-api");
  const load = createObsidianApi({ app: {} }).loadMermaid as () => Promise<unknown>;
  expect(typeof load).toBe("function");
  await expect(load()).rejects.toMatchObject({ cause: failure });
});
