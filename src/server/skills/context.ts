import type { Project } from '@/shared/api/schemas';
import { discoverSkills } from './catalog';

export function catalogForProject(project?: Pick<Project, 'workspacePath'>) {
  return discoverSkills({ projectPath: project?.workspacePath });
}
