export interface CopyBlock {
	kind: "code" | "quote";
	content: string;
	line: number;
	language?: string;
}

interface Fence {
	marker: string;
	length: number;
	indent: number;
	language: string;
}

function openingFence(line: string): Fence | undefined {
	const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match || (match[2][0] === "`" && match[3].includes("`"))) return undefined;
	return { marker: match[2][0], length: match[2].length, indent: match[1].length, language: match[3].trim().split(/\s+/)[0] };
}

function closesFence(line: string, fence: Fence): boolean {
	const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
	return !!match && match[1][0] === fence.marker && match[1].length >= fence.length;
}

function quoteContent(line: string): string | undefined {
	return /^ {0,3}>[ \t]?(.*)$/.exec(line)?.[1];
}

function paragraphLine(line: string): boolean {
	return !!line.trim() && !/^ {0,3}(?:>|#{1,6}(?:\s|$)|(?:[-+*]|\d+[.)])\s|(?:[-*_][ \t]*){3,}$)/.test(line)
		&& !openingFence(line) && !/^ {0,3}(?:={3,}|-{3,})[ \t]*$/.test(line);
}

// This scanner selects outer fences and blockquotes, not rendered Markdown.
// A quote is one candidate; Markdown within it remains intact, including nested quotes.
export function extractCopyBlocks(text: string): CopyBlock[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const blocks: CopyBlock[] = [];
	let index = 0;
	while (index < lines.length) {
		const start = index;
		const fence = openingFence(lines[index]);
		if (fence) {
			index++;
			const content: string[] = [];
			while (index < lines.length && !closesFence(lines[index], fence)) {
				// Markdown permits up to the opening fence's indentation on body lines.
				const line = lines[index++];
				const indent = Math.min(fence.indent, /^ */.exec(line)?.[0].length ?? 0);
				content.push(line.slice(indent));
			}
			if (index < lines.length) index++;
			const body = content.join("\n");
			if (body.trim()) blocks.push({ kind: "code", content: body, line: start + 1, language: fence.language });
			continue;
		}

		if (quoteContent(lines[index]) !== undefined) {
			const content: string[] = [];
			let quotedFence: Fence | undefined;
			let paragraph = false;
			while (index < lines.length) {
				const quoted = quoteContent(lines[index]);
				if (quoted !== undefined) {
					content.push(quoted);
					if (quotedFence) {
						if (closesFence(quoted, quotedFence)) quotedFence = undefined;
						paragraph = false;
					} else {
						quotedFence = openingFence(quoted);
						paragraph = paragraphLine(quoted);
					}
				} else if (!quotedFence && paragraph && paragraphLine(lines[index])) {
					// A paragraph can continue without another explicit quote marker.
					content.push(lines[index]);
				} else {
					break;
				}
				index++;
			}
			const body = content.join("\n");
			if (body.trim()) blocks.push({ kind: "quote", content: body, line: start + 1 });
			continue;
		}
		index++;
	}
	return blocks;
}
