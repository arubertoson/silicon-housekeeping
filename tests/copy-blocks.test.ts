import { describe, expect, it } from "vitest";
import { extractCopyBlocks } from "../support/copy-blocks.ts";

const markdown = (...lines: string[]) => lines.join("\n");

describe("copy fence extraction", () => {
	it.each([
		{ name: "backticks", source: "```ts\nconst x = 1;\n```", content: "const x = 1;", language: "ts" },
		{ name: "tildes", source: "~~~sh\nprintf ok\n~~~", content: "printf ok", language: "sh" },
		{ name: "no language", source: "```\nplain\n```", content: "plain", language: "" },
		{ name: "info string", source: "```typescript title=example\ncode\n```", content: "code", language: "typescript" },
		{ name: "longer closing fence", source: "````\n```\ninside\n`````", content: "```\ninside", language: "" },
		{ name: "short closing fence", source: "````\na\n```\nb\n````", content: "a\n```\nb", language: "" },
		{ name: "wrong closing marker", source: "```\na\n~~~\nb\n```", content: "a\n~~~\nb", language: "" },
		{ name: "closing fence with text", source: "```\na\n``` nope\nb\n```", content: "a\n``` nope\nb", language: "" },
		{ name: "indented opening", source: "  ```python\n  if ready:\n    run()\n ```", content: "if ready:\n  run()", language: "python" },
		{ name: "preserved whitespace", source: "```\n\n  a  \n\n```", content: "\n  a  \n", language: "" },
		{ name: "CRLF", source: "~~~txt\r\na\r\nb\r\n~~~", content: "a\nb", language: "txt" },
		{ name: "unclosed fence", source: "```txt\na\nb\n", content: "a\nb\n", language: "txt" },
	])("extracts $name", ({ source, content, language }) => {
		expect(extractCopyBlocks(source)).toEqual([{ kind: "code", content, line: 1, language }]);
	});

	it.each([
		"inline ```code```", "    ```\n    indented code\n    ```", "``\ntoo short\n``", "```bad`info\ntext",
		"```\n \n```", "~~~\n\n~~~", "```", "No blocks here.", "",
	])("does not invent a copy candidate for %j", (source) => {
		expect(extractCopyBlocks(source)).toEqual([]);
	});

	it("does not interpret quote markers or Markdown within fenced code", () => {
		const body = markdown("> literal", ">> also literal", "", "# heading", "~~~", "> ```", "   > literal again");
		expect(extractCopyBlocks(`\`\`\`markdown\n${body}\n\`\`\``)).toEqual([
			{ kind: "code", content: body, line: 1, language: "markdown" },
		]);
	});
});

describe("copy blockquote extraction", () => {
	it.each([
		{ name: "multiline", source: "> first\n> second", content: "first\nsecond" },
		{ name: "no space", source: ">first\n>second", content: "first\nsecond" },
		{ name: "indentation and tab separator", source: "   > first\n >\tsecond", content: "first\nsecond" },
		{ name: "paragraphs", source: "> first\n>\n> second", content: "first\n\nsecond" },
		{ name: "lazy paragraph continuation", source: "> first\ncontinued\n> third", content: "first\ncontinued\nthird" },
		{ name: "nested quote", source: "> outer\n> > inner\n> end", content: "outer\n> inner\nend" },
		{ name: "inline Markdown", source: "> **important** and `code`", content: "**important** and `code`" },
		{ name: "literal greater-than", source: "> a > b\n>  spaced  ", content: "a > b\n spaced  " },
	])("extracts $name", ({ source, content }) => {
		expect(extractCopyBlocks(source)).toEqual([{ kind: "quote", content, line: 1 }]);
	});

	it("preserves fenced code inside a quote without creating overlapping candidates", () => {
		const content = markdown("Quote:", "", "```sh", "> code data", "```", "", "After code.");
		const source = content.split("\n").map((line) => `> ${line}`).join("\n");
		expect(extractCopyBlocks(source)).toEqual([{ kind: "quote", content, line: 1 }]);
	});

	it("does not absorb an unquoted fence or heading as a lazy paragraph continuation", () => {
		expect(extractCopyBlocks(markdown("> quote", "```sh", "> code data", "```", "# heading", "outside"))).toEqual([
			{ kind: "quote", content: "quote", line: 1 },
			{ kind: "code", content: "> code data", line: 2, language: "sh" },
		]);
	});

	it.each([">", "> \n>\t", "    > indented code", "\\> escaped", "text > inline"])("ignores empty and non-quote content %j", (source) => {
		expect(extractCopyBlocks(source)).toEqual([]);
	});

	it("returns separate blocks in source order with original line numbers", () => {
		expect(extractCopyBlocks(markdown("", "Intro", "~~~js", "run()", "~~~", "", "> first", ">", "> second", "", "> third"))).toEqual([
			{ kind: "code", content: "run()", line: 3, language: "js" },
			{ kind: "quote", content: "first\n\nsecond", line: 7 },
			{ kind: "quote", content: "third", line: 11 },
		]);
	});
});
