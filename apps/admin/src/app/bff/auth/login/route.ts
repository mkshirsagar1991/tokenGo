import { handleLogin } from '@/lib/server/bff';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleLogin(req);
