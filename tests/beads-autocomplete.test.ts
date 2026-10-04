import { describe, expect, it } from "vitest";

import { createBeadsAutocompleteProvider, parseBeadsList } from "../extensions/beads-autocomplete.js";

describe("Beads autocomplete", () => {
  it("parses task records from bd JSON output", () => {
    const tasks = parseBeadsList(JSON.stringify([
      { id: "bd-a1", title: "Add task autocomplete", status: "open", priority: 1 },
      { id: "bd-a2", title: "Incomplete" },
      null,
    ]));

    expect(tasks).toEqual([
      { id: "bd-a1", title: "Add task autocomplete", status: "open", priority: "P1" },
    ]);
  });

  it("accepts wrapped issue arrays and ignores malformed JSON", () => {
    expect(parseBeadsList(JSON.stringify({ issues: [{ id: "bd-b1", title: "Review", status: "open" }] })))
      .toEqual([{ id: "bd-b1", title: "Review", status: "open", priority: undefined }]);
    expect(parseBeadsList("not json")).toEqual([]);
  });

  it("ranks task suggestions for bd references and delegates other input", async () => {
    let delegated = false;
    const current = {
      getSuggestions: async () => {
        delegated = true;
        return null;
      },
      applyCompletion: (lines: string[]) => ({ lines, cursorLine: 0, cursorCol: 0 }),
    };
    const tasks = parseBeadsList(JSON.stringify([
      { id: "bd-20", title: "Improve completion", status: "open" },
      { id: "bd-2", title: "Other task", status: "open" },
      { id: "bd-3", title: "Completion polish", status: "blocked" },
    ]));
    const provider = createBeadsAutocompleteProvider(current, () => tasks, async () => {});
    const options = { signal: new AbortController().signal };

    const text = "Pick bd:completion";
    const suggestions = await provider.getSuggestions([text], 0, text.length, options);
    expect(suggestions?.prefix).toBe("bd:completion");
    expect(suggestions?.items.map((item) => item.value)).toEqual(["bd-3", "bd-20"]);
    expect(suggestions?.items[0]?.description).toContain("Completion polish");

    const idText = "Pick bd:bd-2";
    const idSuggestions = await provider.getSuggestions([idText], 0, idText.length, options);
    expect(idSuggestions?.items.map((item) => item.value)).toEqual(["bd-2", "bd-20"]);

    delegated = false;
    await provider.getSuggestions(["Pick #symbol"], 0, 12, options);
    expect(delegated).toBe(true);
  });
});
