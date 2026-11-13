import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { TableWidget } from "../../src/editor/table-widget";
import { parseTableSource } from "../../src/editor/table-model";

it("renders only source-approved math after Markdown removes dollar escapes", async () => {
  const view = new EditorView();
  const source =
    "| A |\n|---|\n| \\$escaped$ and $\\frac{1}{2}$ and `$code$` |";
  const widget = new TableWidget(parseTableSource(source)!);
  const root = widget.toDOM(view);
  document.body.append(root);
  try {
    await vi.waitFor(() =>
      expect(root.querySelectorAll(".katex")).toHaveLength(1),
    );
    expect(root.querySelector("td")?.textContent).toContain("$escaped$");
    expect(root.querySelector("annotation")?.textContent).toBe("\\frac{1}{2}");
    expect(root.querySelector("code")?.textContent).toBe("$code$");
  } finally {
    widget.destroy(root);
    root.remove();
    view.destroy();
  }
});
