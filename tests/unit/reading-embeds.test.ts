import { EditorState } from "@codemirror/state";
import { expect, it, vi } from "vitest";
import { CompatibilitySession } from "../../src/compat/session";
import { Editor } from "../../src/compat/editor-adapter";
import { EditorExtensionRegistry } from "../../src/compat/editor-extensions";
import { ReadingView } from "../../src/app/reading";
import { MemoryPort } from "../helpers/vault-store";

const pdf = vi.hoisted(() => ({ load: vi.fn(), dispose: vi.fn() }));
vi.mock("../../src/app/pdf", () => ({ PdfView: class {
  el = document.createElement("section");
  load = pdf.load;
  dispose = pdf.dispose;
} }));

async function render(text: string) {
  const port = new MemoryPort({
    "Note.md": text,
    "Attachments/Paper.pdf": "%PDF-1.4",
    "Attachments/Talk.mp3": "ID3",
    "Attachments/Clip.mp4": "mp4",
  });
  const session = await CompatibilitySession.create({
    vaultId: port.vaultId,
    name: "Reading embeds",
    mobile: false,
    port,
    editor: new Editor({
      state: EditorState.create(),
      hasFocus: false,
      scrollDOM: document.createElement("div"),
      dispatch() {},
      focus() {},
      requestMeasure() {},
    }),
    extensions: new EditorExtensionRegistry(() => {}),
    container: document.createElement("div"),
    navigate: async () => {},
  });
  const el = document.createElement("div");
  const app = {
    compatibility: session,
    index: {
      resolve: (target: string) => {
        const name = target.split("#")[0];
        return name.startsWith("Attachments/") ? name : null;
      },
      content: (): string | undefined => undefined,
    },
    openLink: vi.fn(),
    report: (error: unknown) => { throw error; },
  };
  const view = new ReadingView(app as never, el);
  return { view, el, session, app };
}

it("renders PDF pages locally and audio/video through vault object URLs", async () => {
  const create = vi.fn(() => "blob:basalt-media");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  const { view, el, session } = await render(
    "![[Attachments/Paper.pdf#page=3&height=420]]\n\n![[Attachments/Talk.mp3]]\n\n![[Attachments/Clip.mp4]]",
  );
  view.render("Note.md", "![[Attachments/Paper.pdf#page=3&height=420]]\n\n![[Attachments/Talk.mp3]]\n\n![[Attachments/Clip.mp4]]");
  await vi.waitFor(() => {
    expect(el.querySelector(".pdf-embed .pdf-frame section")).toBeTruthy();
    expect(pdf.load).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), 3);
  });
  const embed = el.querySelector<HTMLElement>(".pdf-embed")!;
  expect(embed.style.height).toBe("420px");
  expect(el.querySelector<HTMLAudioElement>(".audio-embed audio")?.getAttribute("src")).toBe("blob:basalt-media");
  expect(el.querySelector<HTMLVideoElement>(".video-embed video")?.getAttribute("src")).toBe("blob:basalt-media");
  expect(create).toHaveBeenCalledTimes(2);
  view.clear();
  expect(pdf.dispose).toHaveBeenCalled();
  await session.dispose();
});

it("lets links in callout titles navigate without folding", async () => {
  const text = "> [!tip]- Siehe [[Ziel]]\n> Inhalt";
  const { view, el, session, app } = await render(text);
  view.render("Note.md", text);
  const callout = el.querySelector<HTMLElement>(".callout")!;
  const link = callout.querySelector<HTMLAnchorElement>(".callout-title a")!;
  link.click();
  expect(app.openLink).toHaveBeenCalledWith("Ziel", "Note.md", false);
  expect(callout.classList.contains("is-collapsed")).toBe(true);
  await session.dispose();
});

it("exposes resolved transclusion targets to plugin post processors", async () => {
  const { view, el, session, app } = await render("![[Attachments/Drawing.md#^group=shape]]");
  app.index.content = () => "Drawing source";
  session.services.registerMarkdownPostProcessor("drawing-test", (root: HTMLElement) => {
    const embed = root.querySelector<HTMLElement>('.internal-embed[src="Attachments/Drawing.md#^group=shape"]');
    if (embed) embed.textContent = "Plugin drawing";
  });
  view.render("Note.md", "![[Attachments/Drawing.md#^group=shape]]");
  await vi.waitFor(() => expect(el.textContent).toContain("Plugin drawing"));
  expect(el.textContent).not.toContain("Drawing source");
  view.clear();
  await session.dispose();
});

it("revokes media object URLs when the reading view is cleared", async () => {
  const create = vi.fn(() => "blob:basalt-clear");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  const { view, el, session } = await render("![[Attachments/Talk.mp3]]");
  view.render("Note.md", "![[Attachments/Talk.mp3]]");
  await vi.waitFor(() => expect(el.querySelector("audio")?.getAttribute("src")).toBe("blob:basalt-clear"));
  view.clear();
  expect(revoke).toHaveBeenCalledWith("blob:basalt-clear");
  await session.dispose();
});

it("renders formulas without treating prices as math", async () => {
  const text = "Preis: $5 und $10. Formel: $x^2$.";
  const { view, el, session } = await render(text);
  view.render("Note.md", text);
  await vi.waitFor(() => expect(el.querySelector(".katex")).toBeTruthy());
  expect(el.textContent).toContain("Preis: $5 und $10");
  expect(el.querySelector(".katex")?.textContent).toContain("x");
  await session.dispose();
});

it("marks media embeds unavailable without a native vault bridge", async () => {
  const el = document.createElement("div");
  const view = new ReadingView({
    index: { resolve: () => "Attachments/Paper.pdf", content: () => undefined },
  } as never, el);
  view.render("Note.md", "![[Attachments/Paper.pdf]]");
  await vi.waitFor(() => expect(el.querySelector(".pdf-embed")?.classList.contains("is-unavailable")).toBe(true));
});

it("toggles folded callouts by click and keyboard", async () => {
  const text = "> [!success]- Lösung\n> Versteckter Rechenweg";
  const { view, el, session } = await render(text);
  view.render("Note.md", text);
  const callout = el.querySelector<HTMLElement>(".callout")!;
  const title = callout.querySelector<HTMLElement>(".callout-title")!;
  expect(callout.classList.contains("is-collapsed")).toBe(true);
  title.click();
  expect(callout.classList.contains("is-collapsed")).toBe(false);
  expect(title.getAttribute("aria-expanded")).toBe("true");
  title.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  expect(callout.classList.contains("is-collapsed")).toBe(true);
  expect(title.getAttribute("aria-expanded")).toBe("false");
  await session.dispose();
});
