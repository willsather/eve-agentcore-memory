import type { MemoryToolsContext } from "eve/memory";
import type { Config } from "../options.js";
import { searchTool } from "./search.js";
import { rememberTool } from "./remember.js";
import { forgetTool } from "./forget.js";

export function createTools(context: MemoryToolsContext, config: Config) {
  const scopeKey = context.memory.scope.key;
  return {
    search: searchTool(config, scopeKey),
    remember: rememberTool(context, config),
    forget: forgetTool(config, scopeKey),
  };
}
