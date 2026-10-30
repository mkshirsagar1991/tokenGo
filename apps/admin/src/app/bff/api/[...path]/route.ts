import { handleProxy } from '@/lib/server/bff';

export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ path: string[] }>;
}

async function handler(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return handleProxy(req, path);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH };
