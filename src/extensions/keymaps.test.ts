import { describe, expect, it } from "vitest";

import { isKeyId, KeymapTree } from "./keymaps.js";

describe("isKeyId", () => {
  it("accepts supported base keys", () => {
    expect(isKeyId("a")).toBe(true);
    expect(isKeyId("0")).toBe(true);
    expect(isKeyId("escape")).toBe(true);
    expect(isKeyId("pageUp")).toBe(true);
    expect(isKeyId("+")).toBe(true);
  });

  it("accepts supported modified keys", () => {
    expect(isKeyId("ctrl+a")).toBe(true);
    expect(isKeyId("ctrl+shift+p")).toBe(true);
    expect(isKeyId("alt+enter")).toBe(true);
    expect(isKeyId("super+k")).toBe(true);
    expect(isKeyId("ctrl++")).toBe(true);
  });

  it("rejects invalid keys", () => {
    expect(isKeyId(1)).toBe(false);
    expect(isKeyId("")).toBe(false);
    expect(isKeyId("ctrl+")).toBe(false);
    expect(isKeyId("ctrl+nonsense")).toBe(false);
    expect(isKeyId("ctrl+ctrl+a")).toBe(false);
    expect(isKeyId("meta+a")).toBe(false);
  });
});

describe("KeymapTree", () => {
  it("runs through nested keymaps", () => {
    const tree = new KeymapTree();

    tree.add({ sequence: ["f", "f"], description: "Find file", command: "findFile" });
    tree.add({ sequence: ["f", "g"], description: "Grep", command: "grep" });
    tree.add({ sequence: ["q"], description: "Quit", command: "quit" });

    expect(tree.size).toBe(3);
    expect(tree.isEmpty).toBe(false);

    expect(tree.next("f")?.entry).toBeUndefined();
    expect(tree.next("g")?.entry?.command).toBe("grep");

    tree.reset();

    expect(tree.next("q")?.entry?.command).toBe("quit");
  });

  it("keeps the current node when a wrong continuation key is pressed", () => {
    const tree = new KeymapTree();

    tree.add({ sequence: ["f", "f"], description: "Find file", command: "findFile" });

    expect(tree.next("f")?.entry).toBeUndefined();
    expect(tree.next("x")?.entry).toBeUndefined();
    expect(tree.next("f")?.entry?.command).toBe("findFile");
  });

  it("matches terminal input against modified key ids", () => {
    const tree = new KeymapTree();

    tree.add({ sequence: ["ctrl+a"], description: "Ctrl A", command: "ctrlA" });

    expect(tree.next("\u0001")?.entry?.command).toBe("ctrlA");
  });

  it("preserves command args", () => {
    const tree = new KeymapTree();

    tree.add({ sequence: ["n"], command: "name", args: "new name" });

    expect(tree.next("n")?.entry).toMatchObject({ command: "name", args: "new name" });
  });

  it("throws on empty and duplicate keymaps", () => {
    const tree = new KeymapTree();

    expect(() => tree.add({ sequence: [], description: "Empty", command: "empty" })).toThrow(
      "Empty key sequence.",
    );

    tree.add({ sequence: ["q"], description: "Quit", command: "quit" });

    expect(() =>
      tree.add({ sequence: ["q"], description: "Quit again", command: "quitAgain" }),
    ).toThrow("Duplicate keymap for q.");
  });
});
