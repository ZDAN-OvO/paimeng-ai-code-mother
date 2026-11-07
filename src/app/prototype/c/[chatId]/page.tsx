'use client';

import { useParams } from 'next/navigation';
import { Workspace } from '@/prototype/components/workspace';

export default function ChatPage() {
  const params = useParams<{ chatId: string }>();
  return <Workspace chatId={params.chatId} />;
}
