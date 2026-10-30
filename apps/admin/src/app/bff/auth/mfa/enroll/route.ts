import { handleMfaEnroll } from '@/lib/server/bff';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleMfaEnroll(req);
