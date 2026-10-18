// Public configuration API (ADR-008): compile once at activation, resolve cheaply afterwards.

export type {
  CompileResult, ConfigSnapshot, ContextInfo, DiagnosticsLevel, RuleActions, ValidationError, WindowRuleResult,
} from "./types.ts";
export { compileConfig, DEFAULT_DIAGNOSTICS, DEFAULT_OSD, DEFAULT_TRACE_CAPACITY } from "./compile.ts";
export { BUILTIN_EXCLUDED_KINDS, resolveContext, resolveWindow, ruleCacheKey, type ContextResolution } from "./resolve.ts";
export { FLAT_KEYS } from "./schema.ts";
export { MAX_OVERRIDES, MAX_PATTERN, MAX_RULES, MAX_STRING } from "./validate.ts";

import type { ValidationError } from "./types.ts";

/** "rules[2].actions.colour: unknown key" */
export function formatError(e: ValidationError): string {
  return e.path ? `${e.path}: ${e.message}` : e.message;
}
