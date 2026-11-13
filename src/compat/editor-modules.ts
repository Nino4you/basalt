import * as commands from "@codemirror/commands";
import * as language from "@codemirror/language";
import * as state from "@codemirror/state";
import * as view from "@codemirror/view";
import * as common from "@lezer/common";
import * as highlight from "@lezer/highlight";
import * as lr from "@lezer/lr";
import { tokenClassNodeProp } from "../editor/syntax";
import { pluginPath } from "./plugin-path";

/** Plugins must use the same editor/parser instances as the host. */
export const editorModules = Object.freeze({
  path: pluginPath,
  "@codemirror/commands": commands,
  "@codemirror/language": { ...language, tokenClassNodeProp },
  "@codemirror/state": state,
  "@codemirror/view": view,
  "@lezer/common": common,
  "@lezer/highlight": highlight,
  "@lezer/lr": lr,
});
