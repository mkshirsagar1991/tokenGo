import { handleKeepalive } from '@/lib/server/bff';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleKeepalive(req);
