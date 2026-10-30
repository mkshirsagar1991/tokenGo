import { handleExpired } from '@/lib/server/bff';

export const dynamic = 'force-dynamic';
export const GET = (req: Request) => handleExpired(req);
