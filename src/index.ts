import { SkillFilterPlugin } from "./plugin"

export { SkillFilterPlugin }
export type { SkillFilterConfig, SkillPatterns, NormalizedRules } from "./types"
export { loadConfig } from "./config/loader"
export { applyFilter } from "./filter/apply"
export { decideAction, hasWork } from "./matching/rules"
export { matchesPattern, globToRegExp } from "./matching/glob"

export default SkillFilterPlugin
