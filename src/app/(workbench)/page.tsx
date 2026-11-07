import { Suspense } from 'react';
import HomeView from '@/features/home/home-view';

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <HomeView />
    </Suspense>
  );
}
