import { describe, expect, it } from "vitest";
import { createObsidianApi } from "../../src/compat/obsidian-api";

const api = createObsidianApi({ app: {} }) as unknown as {
  arrayBufferToBase64(buffer: ArrayBuffer): string;
  base64ToArrayBuffer(base64: string): ArrayBuffer;
  arrayBufferToHex(data: ArrayBuffer): string;
  hexToArrayBuffer(hex: string): ArrayBuffer;
  getBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer>;
};

const bytes = new Uint8Array([0, 1, 254, 255]).buffer;

describe("buffer helpers", () => {
  it("round-trips base64", () => {
    expect(api.arrayBufferToBase64(bytes)).toBe("AAH+/w==");
    expect([...new Uint8Array(api.base64ToArrayBuffer("AAH+/w=="))]).toEqual([
      0, 1, 254, 255,
    ]);
    expect(api.arrayBufferToBase64(new ArrayBuffer(0))).toBe("");
  });

  it("round-trips lowercase hex", () => {
    expect(api.arrayBufferToHex(bytes)).toBe("0001feff");
    expect([...new Uint8Array(api.hexToArrayBuffer("0001feff"))]).toEqual([
      0, 1, 254, 255,
    ]);
  });

  it("rejects malformed hex instead of decoding partial bytes", () => {
    expect(() => api.hexToArrayBuffer("abc")).toThrow();
    expect(() => api.hexToArrayBuffer("zz")).toThrow();
  });

  it("reads a blob as an ArrayBuffer", async () => {
    const buffer = await api.getBlobArrayBuffer(new Blob([bytes]));
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array(bytes));
  });
});
