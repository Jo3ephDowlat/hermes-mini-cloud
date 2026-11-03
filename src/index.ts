interface Env {
	// Bindings (D1, KV, secrets) will be added in later phases.
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

export default {
	async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (request.method !== "GET") {
			return jsonResponse({ error: "Method not allowed" }, 405);
		}

		switch (pathname) {
			case "/":
				return jsonResponse({
					message: "Welcome to hermes-mini-cloud",
					service: "hermes-mini-cloud",
					version: "0.1.0",
				});
			case "/health":
				return jsonResponse({
					ok: true,
					service: "hermes-mini-cloud",
					status: "running",
				});
			default:
				return jsonResponse({ error: "Not found", path: pathname }, 404);
		}
	},
};
