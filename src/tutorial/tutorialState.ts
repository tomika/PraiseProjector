import type { TutorialBranch, TutorialCursor, TutorialDefinition, TutorialStep } from "./tutorialTypes";

export interface ResolvedTutorialStep {
  primary: TutorialStep;
  step: TutorialStep;
  primaryIndex: number;
  detailIndex: number | null;
  branch: TutorialBranch | null;
}

export function initialTutorialCursor(definition: TutorialDefinition): TutorialCursor | null {
  const first = definition.steps[0];
  return first ? { primaryId: first.id } : null;
}

export function resolveTutorialCursor(definition: TutorialDefinition, cursor: TutorialCursor): ResolvedTutorialStep | null {
  const primaryIndex = definition.steps.findIndex((step) => step.id === cursor.primaryId);
  if (primaryIndex < 0) return null;
  const primary = definition.steps[primaryIndex];
  if (!cursor.detailId) return { primary, step: primary, primaryIndex, detailIndex: null, branch: null };

  if (cursor.branchId) {
    const branch = primary.branches?.find((candidate) => candidate.id === cursor.branchId);
    const detailIndex = branch?.steps.findIndex((step) => step.id === cursor.detailId) ?? -1;
    if (!branch || detailIndex < 0) return null;
    return { primary, step: branch.steps[detailIndex], primaryIndex, detailIndex, branch };
  }

  const detailIndex = primary.details?.findIndex((step) => step.id === cursor.detailId) ?? -1;
  if (detailIndex < 0 || !primary.details) return null;
  return { primary, step: primary.details[detailIndex], primaryIndex, detailIndex, branch: null };
}

export function firstDetailCursor(step: ResolvedTutorialStep): TutorialCursor | null {
  const first = step.primary.details?.[0];
  return first ? { primaryId: step.primary.id, detailId: first.id } : null;
}

export function firstBranchCursor(step: ResolvedTutorialStep, branchId: string): TutorialCursor | null {
  const branch = step.primary.branches?.find((candidate) => candidate.id === branchId);
  const first = branch?.steps[0];
  return first ? { primaryId: step.primary.id, branchId, detailId: first.id } : null;
}

export function nextTutorialCursor(definition: TutorialDefinition, current: ResolvedTutorialStep): TutorialCursor | null {
  if (current.detailIndex !== null) {
    const detailSteps = current.branch ? current.branch.steps : current.primary.details;
    const nextDetail = detailSteps?.[current.detailIndex + 1];
    if (nextDetail) {
      return { primaryId: current.primary.id, detailId: nextDetail.id, ...(current.branch ? { branchId: current.branch.id } : {}) };
    }
  }

  const nextPrimary = definition.steps[current.primaryIndex + 1];
  return nextPrimary ? { primaryId: nextPrimary.id } : null;
}

export function previousTutorialCursor(definition: TutorialDefinition, current: ResolvedTutorialStep): TutorialCursor | null {
  if (current.detailIndex !== null) {
    const detailSteps = current.branch ? current.branch.steps : current.primary.details;
    const previousDetail = detailSteps?.[current.detailIndex - 1];
    return previousDetail
      ? { primaryId: current.primary.id, detailId: previousDetail.id, ...(current.branch ? { branchId: current.branch.id } : {}) }
      : { primaryId: current.primary.id };
  }

  const previousPrimary = definition.steps[current.primaryIndex - 1];
  return previousPrimary ? { primaryId: previousPrimary.id } : null;
}
