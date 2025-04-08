import type { IncomingRequestCfProperties } from '@cloudflare/workers-types';

export const createIncomingRequest = (input: RequestInfo, cf?: Partial<IncomingRequestCfProperties<unknown>>): Request<unknown, IncomingRequestCfProperties<unknown>> =>
{
	const req = new Request(input);
  Object.defineProperty(req, 'cf',
	{
		configurable: true,
    value: cf || {},
    writable: true
  });

  return req as Request<unknown, IncomingRequestCfProperties<unknown>>;
};
