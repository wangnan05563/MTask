/**
 * 代码评审「加载 diff」前置校验（T05715）：维度从「跨 Git 仓库」改为「跨工作空间(projectId)」。
 * 抽成纯函数便于单测——同一工作空间下允许勾选多个不同 Git 仓库的提交；
 * 仅当勾选的已完成任务跨越不同工作空间时才返回拦截文案。
 */
export interface ScopeCheckTask {
  readonly id: string;
  readonly projectId: string;
  /** 每条提交所属的子仓库（缺省 = 项目根仓库） */
  readonly commits: ReadonlyArray<{ readonly repoSub?: string }>;
}

export const WORKSPACE_CROSS_ERROR =
  '勾选的提交跨了多个工作空间。一次只能采集同一工作空间内的提交，请确保所选任务属于同一工作空间，或分批加载不同工作空间的 diff。';

export function checkLectureScopeWorkspaces(
  doneTasks: ReadonlyArray<ScopeCheckTask>,
  checkedTaskIds: ReadonlyArray<string>,
): string {
  const workspaces = new Set<string>();
  for (const t of doneTasks) {
    if (!checkedTaskIds.includes(t.id)) continue;
    if (t.commits.length === 0) continue;
    workspaces.add(t.projectId);
  }
  return workspaces.size > 1 ? WORKSPACE_CROSS_ERROR : '';
}
