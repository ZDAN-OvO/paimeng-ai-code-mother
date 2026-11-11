import type { Project } from '@/shared/api/schemas';
import { discoverSkills } from './catalog';

export function catalogForProject(project?: Pick<Project, 'workspacePath' | 'workspaceState'>) {
  return discoverSkills({
    projectPath: project?.workspaceState === 'linked' ? project.workspacePath : undefined,
  });
}
