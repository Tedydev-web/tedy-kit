const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function apiMessage(data, text) {
  return data?.message ?? data?.error?.message ?? data?.err ?? data?._embedded?.errors?.map((error) => error.message).join("; ") ?? text.slice(0, 200);
}

export async function requestJson(url, { method = "GET", headers = {}, body, retries = 3, wait = (seconds) => new Promise((done) => setTimeout(done, seconds * 1000)) } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (RETRY_STATUSES.has(response.status) && attempt < retries) {
      await wait(Number(response.headers.get("retry-after")) || 2 ** (attempt + 1));
      continue;
    }
    const text = await response.text();
    const data = text ? parse(text) : null;
    if (!response.ok) {
      const limit = response.headers.get("x-figma-rate-limit-type");
      throw new Error(`${method} ${new URL(url).pathname} returned HTTP ${response.status}: ${apiMessage(data, text)}${limit ? ` (rate limit type ${limit})` : ""}`);
    }
    return data;
  }
}
