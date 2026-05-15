export const BASE_COOKIE =
  "CONSENT=YES+; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpXzIwMjMwMTEwLjA3X3AxLjhmGgJlbiACGgYIgLCjnwY;";

export const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Cookie: BASE_COOKIE,
  DNT: "1",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
};

export async function warmUpSession() {
  const r = await fetch("https://www.google.com/maps", {
    redirect: "follow",
    headers: BROWSER_HEADERS,
  });
  const setCookies = (r.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .join("; ");
  BROWSER_HEADERS.Cookie = BASE_COOKIE + " " + setCookies;
}
