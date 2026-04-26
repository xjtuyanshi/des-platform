import { createHash, randomUUID } from 'node:crypto';

import {
  analyzeDesModel,
  type ModelDiagnostic,
  type ModelDiagnosticsReport,
  type ModelRepairCandidate
} from '@des-platform/model-compiler';
import { AiNativeDesModelDefinitionSchema } from '@des-platform/shared-schema/model-dsl';

export type JsonPatchOperation = ModelRepairCandidate['patch'][number];

export type RepairOption = {
  id: string;
  diagnosticIndex: number;
  diagnostic: ModelDiagnostic;
  candidate: ModelRepairCandidate;
};

export type RepairPlan = {
  modelHash: string;
  diagnostics: ModelDiagnosticsReport;
  options: RepairOption[];
  safeAutoApplyCount: number;
  requiresConfirmationCount: number;
};

export type RepairUserDecision = 'accepted' | 'rejected' | 'autoApplied';

export type RepairAuditEntry = {
  repairSessionId: string;
  modelBeforeHash: string;
  modelAfterHash: string;
  diagnosticCode: string;
  jsonPointer: string;
  repairCandidate: ModelRepairCandidate;
  userDecision: RepairUserDecision;
  appliedPatch: JsonPatchOperation[];
  diagnosticsBefore: ModelDiagnostic[];
  diagnosticsAfter: ModelDiagnostic[];
  timestamp: string;
};

export type RepairedModel = {
  model: unknown;
  modelBeforeHash: string;
  modelAfterHash: string;
  diagnosticsBefore: ModelDiagnosticsReport;
  diagnosticsAfter: ModelDiagnosticsReport;
  auditTrail: RepairAuditEntry[];
};

export type ApplySelectedRepairsOptions = {
  candidateIds?: string[];
  includeSafeAuto?: boolean;
  includeRequiresConfirmation?: boolean;
  repairSessionId?: string;
  timestamp?: string;
};

export type RepairValidationResult = {
  validBefore: boolean;
  validAfter: boolean;
  diagnosticsBeforeCount: number;
  diagnosticsAfterCount: number;
  removedDiagnosticCodes: string[];
  addedDiagnosticCodes: string[];
  severeDiagnosticsAfter: ModelDiagnostic[];
};

export function analyzeRepairOptions(model: unknown): RepairPlan {
  const diagnostics = analyzeDesModel(model);
  const options = diagnostics.diagnostics.flatMap((diagnostic, index): RepairOption[] => {
    if (!diagnostic.repairCandidate) {
      return [];
    }
    return [{
      id: repairOptionId(index, diagnostic),
      diagnosticIndex: index,
      diagnostic,
      candidate: diagnostic.repairCandidate
    }];
  });

  return {
    modelHash: stableHash(model),
    diagnostics,
    options,
    safeAutoApplyCount: options.filter((option) => option.candidate.safety === 'safeAutoApply').length,
    requiresConfirmationCount: options.filter((option) => option.candidate.requiresUserConfirmation).length
  };
}

export function applyRepairCandidate(
  model: unknown,
  candidate: ModelRepairCandidate,
  diagnostic: ModelDiagnostic,
  decision: RepairUserDecision = candidate.requiresUserConfirmation ? 'accepted' : 'autoApplied',
  repairSessionId: string = randomUUID(),
  timestamp: string = new Date().toISOString()
): RepairedModel {
  if (decision === 'autoApplied' && candidate.requiresUserConfirmation) {
    throw new Error(`Repair candidate for ${diagnostic.code} requires user confirmation`);
  }

  const diagnosticsBefore = analyzeDesModel(model);
  const modelBeforeHash = stableHash(model);
  const repaired = applyJsonPatch(repairDocumentFor(model), candidate.patch);
  const diagnosticsAfter = analyzeDesModel(repaired);
  const modelAfterHash = stableHash(repaired);
  return {
    model: repaired,
    modelBeforeHash,
    modelAfterHash,
    diagnosticsBefore,
    diagnosticsAfter,
    auditTrail: [{
      repairSessionId,
      modelBeforeHash,
      modelAfterHash,
      diagnosticCode: diagnostic.code,
      jsonPointer: diagnostic.jsonPointer,
      repairCandidate: candidate,
      userDecision: decision,
      appliedPatch: candidate.patch,
      diagnosticsBefore: diagnosticsBefore.diagnostics,
      diagnosticsAfter: diagnosticsAfter.diagnostics,
      timestamp
    }]
  };
}

export function applySelectedRepairs(model: unknown, options: ApplySelectedRepairsOptions = {}): RepairedModel {
  const repairSessionId = options.repairSessionId ?? randomUUID();
  const timestamp = options.timestamp ?? new Date().toISOString();
  const initialPlan = analyzeRepairOptions(model);
  const selectedIds = new Set(options.candidateIds ?? []);
  const includeSafeAuto = options.includeSafeAuto ?? selectedIds.size === 0;
  const includeRequiresConfirmation = options.includeRequiresConfirmation ?? false;

  const selected = initialPlan.options.filter((option) => {
    if (selectedIds.has(option.id)) {
      return true;
    }
    if (includeSafeAuto && option.candidate.safety === 'safeAutoApply') {
      return true;
    }
    return includeRequiresConfirmation && option.candidate.requiresUserConfirmation;
  });

  let current = repairDocumentFor(model);
  const auditTrail: RepairAuditEntry[] = [];
  const diagnosticsBefore = initialPlan.diagnostics;
  const modelBeforeHash = initialPlan.modelHash;

  for (const option of selected) {
    const decision: RepairUserDecision = option.candidate.requiresUserConfirmation ? 'accepted' : 'autoApplied';
    const result = applyRepairCandidate(current, option.candidate, option.diagnostic, decision, repairSessionId, timestamp);
    current = result.model;
    auditTrail.push(...result.auditTrail);
  }

  const diagnosticsAfter = analyzeDesModel(current);
  return {
    model: current,
    modelBeforeHash,
    modelAfterHash: stableHash(current),
    diagnosticsBefore,
    diagnosticsAfter,
    auditTrail
  };
}

export function validateRepair(modelBefore: unknown, modelAfter: unknown): RepairValidationResult {
  const before = analyzeDesModel(modelBefore);
  const after = analyzeDesModel(modelAfter);
  const beforeCodes = countCodes(before.diagnostics);
  const afterCodes = countCodes(after.diagnostics);
  return {
    validBefore: before.valid,
    validAfter: after.valid,
    diagnosticsBeforeCount: before.diagnostics.length,
    diagnosticsAfterCount: after.diagnostics.length,
    removedDiagnosticCodes: [...beforeCodes.keys()].filter((code) => !afterCodes.has(code)),
    addedDiagnosticCodes: [...afterCodes.keys()].filter((code) => !beforeCodes.has(code)),
    severeDiagnosticsAfter: after.errors
  };
}

export function applyJsonPatch(document: unknown, patch: JsonPatchOperation[]): unknown {
  let root = structuredClone(document);
  for (const operation of patch) {
    root = applyJsonPatchOperation(root, operation);
  }
  return root;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function applyJsonPatchOperation(root: unknown, operation: JsonPatchOperation): unknown {
  const segments = parseJsonPointer(operation.path);
  if (segments.length === 0) {
    if (operation.op === 'remove') {
      return null;
    }
    return structuredClone(operation.value);
  }

  const parent = resolveParent(root, segments);
  const key = segments[segments.length - 1]!;
  if (Array.isArray(parent)) {
    const index = key === '-' ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > parent.length) {
      throw new Error(`Patch path ${operation.path} has invalid array index ${key}`);
    }
    if (operation.op === 'add') {
      parent.splice(index, 0, structuredClone(operation.value));
      return root;
    }
    if (index >= parent.length) {
      throw new Error(`Patch path ${operation.path} points past array end`);
    }
    if (operation.op === 'replace') {
      parent[index] = structuredClone(operation.value);
    } else {
      parent.splice(index, 1);
    }
    return root;
  }

  if (!isRecord(parent)) {
    throw new Error(`Patch path ${operation.path} parent is not an object or array`);
  }
  if (operation.op === 'remove') {
    delete parent[key];
  } else {
    parent[key] = structuredClone(operation.value);
  }
  return root;
}

function resolveParent(root: unknown, segments: string[]): unknown {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Patch path cannot resolve array segment ${segment}`);
      }
      current = current[index];
    } else if (isRecord(current) && segment in current) {
      current = current[segment];
    } else {
      throw new Error(`Patch path cannot resolve segment ${segment}`);
    }
  }
  return current;
}

function parseJsonPointer(path: string): string[] {
  if (path === '') {
    return [];
  }
  if (!path.startsWith('/')) {
    throw new Error(`JSON Patch path must be a JSON Pointer: ${path}`);
  }
  return path.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function repairOptionId(index: number, diagnostic: ModelDiagnostic): string {
  return stableHash({
    index,
    code: diagnostic.code,
    pointer: diagnostic.jsonPointer,
    patch: diagnostic.repairCandidate?.patch ?? []
  }).slice(0, 16);
}

function countCodes(diagnostics: ModelDiagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  return counts;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortValue(value[key])])
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repairDocumentFor(model: unknown): unknown {
  const parsed = AiNativeDesModelDefinitionSchema.safeParse(model);
  return parsed.success ? structuredClone(parsed.data) : structuredClone(model);
}
