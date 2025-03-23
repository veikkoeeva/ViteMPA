export default
{
	async fetch(request, env, _ctx): Promise<Response> {

		if('GET' !== request.method)
		{
			return new Response('Method Not Allowed', { status: 405 });
		}

		const response = await env.ASSETS.fetch(request);

    const HttpNotFound = 404;
    if (response.status === HttpNotFound)
		{
      return new Response('Asset not found. Check the URL or try again later.',
			{
        headers: { 'Content-Type': 'text/plain' },
				status: HttpNotFound
      });
    }

    return response;
	}
} satisfies ExportedHandler<Env>;
