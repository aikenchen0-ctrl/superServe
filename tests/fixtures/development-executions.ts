import type { ApiResponse } from '../../src/app/api.ts'

/** 界面夹具只描述已观测状态，不是真实执行或范围静止证明。 */
export function developmentWorkspace(): ApiResponse<'GET development/workspaces'>['items'][number] {
  return { workspaceId: 'a'.repeat(64), operationId: '00000000-0000-4000-8000-000000000001',
    generation: 1, owner: 'task-run', path: 'O:/test-workspace', phase: 'running',
    expiresAt: 1893456000000, expired: false, recoveryRequired: false }
}
export function developmentExecution(): NonNullable<ApiResponse<'GET development/workspaces/:id/execution'>['execution']> {
  const workspace = developmentWorkspace()
  return { workspaceId: workspace.workspaceId, operationId: workspace.operationId, generation: workspace.generation,
    startedAt: 1794090000000, updatedAt: 1794090001000, phase: 'unknown',
    observationProblem: 'range_not_confirmed', outcomeScope: 'trusted_launcher',
    outcome: { kind: 'exited', exitCode: 0, signal: null }, scope: 'provider_managed_range',
    targetResult: { state: 'exited', exitCode: 7, signal: null, observedAt: 1794090000500 },
    targetResultScope: 'direct_child_only', validationPassed: false,
    workspaceReleaseAllowed: false, recoveryRequired: true }
}
