import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

const BULLET = "•";

interface HeaderState {
  preset?: string;
  model?: string;
  thinking?: string;
}

function renderHeader(state: HeaderState, ctx: ExtensionCommandContext): void {
  const preset = state.preset ? state.preset : "none";
  const model = state.model ? state.model : "none";
  const thinking = state.thinking ? state.thinking : "off";

  const header = `${preset} ${BULLET} ${model}:${thinking}`;

  // return {
  //   invalidate() {},
  //   render(width: number) string[] {
  //
  //   },
  // }
  // ctx.ui.setEditorComponent((tui, theme, data) => ctx.ui.theme.fg("dim", header))
}

interface ChatInterface {
  model: Model<Api>;
  thinking: string;
  preset?: string;
}

export default function (pi: ExtensionAPI) {}
