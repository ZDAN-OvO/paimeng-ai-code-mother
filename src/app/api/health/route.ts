import { NextResponse } from 'next/server';
import { ping } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const database = await ping();
  return NextResponse.json({ ok: database, database }, { status: database ? 200 : 503 });
}
