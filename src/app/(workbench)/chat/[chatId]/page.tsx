'use client';

import { useParams } from 'next/navigation';
import { Workspace } from '@/features/workspace/workspace';
import { WorkspaceProvider } from '@/features/workspace/workspace-store';

export default function ChatPage() {
  const params = useParams<{ chatId: string }>();
  return (
    <WorkspaceProvider key={params.chatId} chatId={params.chatId}>
      <Workspace chatId={params.chatId} />
    </WorkspaceProvider>
  );
}
