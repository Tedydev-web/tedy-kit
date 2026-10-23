const SERVER_ERRORS = new Set([500, 502, 503, 504]);
const QUOTA = /quota exceeded|rateLimitExceeded|userRateLimitExceeded/i;

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const SECRET_ASSIGNMENT = /((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)((?:(?:Basic|Bearer)\s+)?[^\s"'&,;{}]{4,})/gi;
export const SECRET_SHAPE = /\b(?:eyJ[\w-]{10,}\.[\w.-]*|[A-Fa-f0-9]{32,}|(?:Basic|Bearer) [\w.~+/=-]{16,}|gh[pousr]_\w{20,}|figd_[\w-]{20,}|ya29\.[\w.-]{20,})/g;

export function redact(text) {
  return String(text ?? "").replace(SECRET_ASSIGNMENT, "$1***").replace(SECRET_SHAPE, "***");
}

function apiMessage(data, text) {
  return data?.message ?? data?.error?.message ?? data?.err ?? data?._embedded?.errors?.map((error) => error.message).join("; ") ?? text.slice(0, 200);
}

export async function requestJson(url, { method = "GET", headers = {}, body, as = "json", retries = 3, wait = (seconds) => new Promise((done) => setTimeout(done, seconds * 1000)) } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? parse(text) : null;
    const quota = response.status === 403 && QUOTA.test(apiMessage(data, text) + JSON.stringify(data?.error?.errors ?? []));
    if ((response.status === 429 || quota || (method === "GET" && SERVER_ERRORS.has(response.status))) && attempt < retries) {
      await wait(Number(response.headers.get("retry-after")) || (quota ? 15 * (attempt + 1) : 2 ** (attempt + 1)));
      continue;
    }
    if (!response.ok) {
      const limit = response.headers.get("x-figma-rate-limit-type");
      throw Object.assign(new Error(`${method} ${new URL(url).pathname} returned HTTP ${response.status}: ${redact(apiMessage(data, text))}${limit ? ` (rate limit type ${limit})` : ""}`), { status: response.status });
    }
    return as === "text" ? text : data;
  }
}
