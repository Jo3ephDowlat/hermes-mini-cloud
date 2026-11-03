interface Env {
	DB: D1Database;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
			case "/health/db": {
				try {
					await env.DB.prepare("SELECT 1 AS ok").first();
					return jsonResponse({
						ok: true,
						service: "hermes-mini-cloud",
						database: "connected",
					});
				} catch (error) {
					console.error("Database health check failed:", error);
					return jsonResponse({ ok: false, database: "unavailable" }, 503);
				}
			}
			default:
				return jsonResponse({ error: "Not found", path: pathname }, 404);
		}
	},
};
