import { handleMfaVerify } from '@/lib/server/bff';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleMfaVerify(req);
