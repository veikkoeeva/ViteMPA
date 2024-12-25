interface Env
{
	ASSETS: Fetcher;
}


export default
{
	async fetch(request, env, ctx): Promise<Response> {

		if(request.method !== 'GET')
		{
			return new Response('Method Not Allowed', { status: 405 });
		}

		return env.ASSETS.fetch(request);
	}
} satisfies ExportedHandler<Env>;
