import { Suspense } from 'react';
import { SkillsView } from '@/features/skills/skills-view';

export default function SkillsPage() {
  return (
    <Suspense fallback={null}>
      <SkillsView />
    </Suspense>
  );
}
