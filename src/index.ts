import { SkillFilterPlugin } from "./plugin"

export { SkillFilterPlugin }
export type {
  SkillFilterConfig,
  SkillPatterns,
  NormalizedRules,
} from "./types"
export { loadConfig } from "./config/loader"
export { applyFilter } from "./filter/apply"
export { decideAction, hasWork } from "./matching/rules"
export { matchesPattern, globToRegExp } from "./matching/glob"
export {
  SKILLS_LIST_TOOL_NAME,
  SKILLS_LIST_TOOL_DESCRIPTION,
  buildSkillsListReport,
  createSkillsListTool,
  formatSkillsList,
} from "./tool/skills-list"
export type { SkillsListReport, SkillListEntry, SkillsListStatus } from "./tool/skills-list"

export default SkillFilterPlugin
