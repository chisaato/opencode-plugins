import { SkillFilterPlugin } from "./plugin"

export { SkillFilterPlugin }
export type {
  SkillFilterConfig,
  SkillPatterns,
  NormalizedRules,
  PolicyRule,
} from "./types"
export { loadConfig } from "./config/loader"
export { resolveOverrides, matchesDirectory } from "./config/overrides"
export {
  maskJsonComments,
  stripTrailingCommas,
  parseJsonc,
  readJsoncFile,
  upsertExperimentalPolicies,
  findRootObject,
  findTopLevelProperty,
  findPropertyInObject,
  structurallyEqual,
  stableStringify,
} from "./config/jsonc"
export type { JsoncFile, ValueSpan, ObjectSpan, UpsertResult } from "./config/jsonc"
export {
  syncPolicies,
  generatePolicies,
  toPolicyRule,
  isManagedPolicy,
  mergePolicies,
  extractPolicies,
  POLICY_ACTION,
  POLICY_RESOURCE_PREFIX,
} from "./policy/sync"
export type { SyncPolicyOptions, SyncPolicyResult } from "./policy/sync"
export {
  getGlobalConfigDir,
  getDefaultConfigPath,
  getDefaultConfigPaths,
  getProjectConfigPaths,
  getProjectConfigCandidateGroups,
  getGlobalOpenCodeConfigPaths,
  resolveUserPath,
  CONFIG_FILENAME,
  CONFIG_FILENAMES,
  OPENCODE_CONFIG_FILENAMES,
} from "./utils/paths"
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
export type {
  SkillsListReport,
  SkillListEntry,
  RemovedSkillEntry,
  SkillState,
  SkillsListStatus,
  PoliciesSummary,
} from "./tool/skills-list"

export default SkillFilterPlugin
