import { Theme } from "@earendil-works/pi-coding-agent";

// A complete, deterministic palette using Pi's real theme and ANSI machinery.
export function testTheme(appearance: "dark" | "light" = "dark"): Theme {
  const fg = appearance === "dark" ? "#dddddd" : "#222222";
  const bg = appearance === "dark" ? "#252525" : "#eeeeee";
  return new Theme({
    accent: "#aa77cc", border: fg, borderAccent: fg, borderMuted: fg,
    success: "#559966", error: "#cc5555", warning: "#bb9944", muted: fg, dim: fg, text: fg,
    thinkingText: fg, scrollbarTrack: fg, scrollbarThumb: fg, searchMatchText: fg,
    userMessageText: fg, customMessageText: fg, customMessageLabel: fg,
    toolTitle: fg, toolOutput: fg, mdHeading: fg, mdLink: fg, mdLinkUrl: fg, mdCode: fg,
    mdCodeBlock: fg, mdCodeBlockBorder: fg, mdQuote: fg, mdQuoteBorder: fg, mdHr: fg, mdListBullet: fg,
    toolDiffAdded: fg, toolDiffRemoved: fg, toolDiffContext: fg, syntaxComment: fg, syntaxKeyword: fg,
    syntaxFunction: fg, syntaxVariable: fg, syntaxString: fg, syntaxNumber: fg, syntaxType: fg,
    syntaxOperator: fg, syntaxPunctuation: fg, thinkingOff: fg, thinkingMinimal: fg,
    thinkingLow: fg, thinkingMedium: fg, thinkingHigh: fg, thinkingXhigh: fg, thinkingMax: fg, bashMode: fg,
  }, {
    selectedBg: bg, searchMatchBg: bg, userMessageBg: bg, customMessageBg: bg,
    toolPendingBg: bg, toolSuccessBg: bg, toolErrorBg: bg,
  }, "truecolor", { appearance });
}
