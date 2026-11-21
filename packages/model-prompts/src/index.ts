import { ModelPromptsPlugin } from "./plugin"

export { ModelPromptsPlugin }
export { loadConfig } from "./config/loader"
export { parseJsonc } from "./config/jsonc"
export { matchesGlob, matchesRule, resolvePromptPath, collectPromptPaths } from "./match"
export { getGlobalConfigDir, getDefaultConfigPaths, getProjectConfigCandidateGroups, resolveUserPath, CONFIG_FILENAMES, PROMPTS_DIR_NAME } from "./utils/paths"
export { createLogger, silentLogger } from "./utils/logger"
export default ModelPromptsPlugin
