import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/app/app";

afterEach(() => {
  document.querySelector(".notice-container")?.remove();
  vi.restoreAllMocks();
});

function context() {
  return {
    store: { saveAll: vi.fn().mockResolvedValue(undefined) },
    compatibility: null as unknown,
    settings: {
      get: vi.fn(() => "en"),
      set: vi.fn(() => true),
    },
    writeWorkspace: vi.fn(),
    report: vi.fn(),
  };
}

it("keeps the current language and workspace when notes cannot save", async () => {
  const app = context();
  const error = new Error("Note version conflict");
  app.store.saveAll.mockRejectedValue(error);
  await App.prototype.changeLanguage.call(app as unknown as App, "de");
  expect(app.settings.set).not.toHaveBeenCalled();
  expect(app.writeWorkspace).not.toHaveBeenCalled();
  expect(app.report).toHaveBeenCalledWith(error);
});

it("waits for plugin buffers before changing the language", async () => {
  const app = context();
  const error = new Error("Plugin version conflict");
  const flushPending = vi.fn().mockRejectedValue(error);
  app.compatibility = { workspace: { flushPending } };
  await App.prototype.changeLanguage.call(app as unknown as App, "de");
  expect(app.store.saveAll).toHaveBeenCalledOnce();
  expect(flushPending).toHaveBeenCalledOnce();
  expect(app.settings.set).not.toHaveBeenCalled();
  expect(app.report).toHaveBeenCalledWith(error);
});

it("restores the previous setting and avoids a reload when persistence fails", async () => {
  const app = context();
  app.settings.set.mockReturnValue(false);
  await App.prototype.changeLanguage.call(app as unknown as App, "de");
  expect(app.store.saveAll).toHaveBeenCalledOnce();
  expect(app.writeWorkspace).toHaveBeenCalledOnce();
  expect(app.settings.set.mock.calls).toEqual([
    ["language", "de"],
    ["language", "en"],
  ]);
  expect(app.report).toHaveBeenCalledWith(expect.any(Error));
});
