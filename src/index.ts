interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * China Pharma MCP — China-to-Western biotech licensing deals, from SEC filings.
 *
 * Why this exists: the demand log has a standing cluster of questions about
 * Chinese biotech business development ("which Chinese biotechs out-licensed to
 * Western pharma", "China licensing deals this month") and ask_pipeworx answered
 * every one of them `no_match` — "none specifically track licensing deal
 * announcements or partnerships." It was right: nothing did.
 *
 * Source: SEC EDGAR full-text search. Any US-listed party to a China licensing
 * deal files an 8-K, and the press release exhibit names the counterparty, the
 * territory and the money. Keyless, and the same efts endpoint the
 * regulatory-catalysts pack already relies on.
 *
 * The scoping matters more than it looks. `"license agreement" AND "China"`
 * returns Yum China and YUM Brands ahead of any biotech — fast food licensing.
 * Requiring deal vocabulary (`upfront payment`, `milestone`) instead returns 24
 * filings over three months, every one of them a pharma company. That is the
 * whole trick: the domain filter is the DEAL language, not the word "pharma".
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'China Pharma');
}

const EFTS = 'https://efts.sec.gov/LATEST/search-index';
const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
// SEC asks for a contactable UA and 403s a generic one.
const UA = 'pipeworx-mcp/1.0 (bruce@mojibake.ai)';

/** Deal vocabulary that separates a pharma licensing deal from a franchising
 *  one. Both terms must appear, which is what keeps fast-food out. */
export const DEAL_TERMS = '"upfront payment" "milestone"';

/** How many filing bodies to open per call. Each is a real fetch against SEC,
 *  and the worker has a request budget — the list itself is already useful, so
 *  detail is best-effort over the first N. */
const MAX_BODIES = 8;

const tools: McpToolExport['tools'] = [
  {
    name: 'china_licensing_deals',
    description:
      'Biotech and pharmaceutical licensing deals involving China — a Chinese company out-licensing a drug to a Western partner, or a Western company licensing rights INTO Greater China. Returns the two companies, the drug or asset, the territory, the upfront payment, milestone totals and royalty terms, with the SEC filing they were announced in and its date. Answers "which Chinese biotechs signed out-licensing deals", "recent China pharma licensing deals", "who licensed rights in Greater China". Sourced from SEC 8-K announcements, so it covers any deal with a US-listed party. Filter by company, drug name or date window.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Optional extra term to narrow the search — a company ("Hengrui"), a drug ("VIZZ"), a modality ("ADC", "bispecific") or a therapy area ("oncology"). Combined with the deal and China terms, not replacing them.',
        },
        since: { type: 'string', description: 'Earliest filing date (YYYY-MM-DD). Defaults to 90 days ago.' },
        until: { type: 'string', description: 'Latest filing date (YYYY-MM-DD). Defaults to today.' },
        limit: { type: 'number', description: 'Maximum deals to return, 1-40 (default 10).' },
      },
    },
  },
  {
    name: 'nmpa_updates',
    description:
      "Official announcements from China's drug regulator, the NMPA (National Medical Products Administration) — regulatory policy changes, guidance documents, import rules, clinical-trial guideline updates and reform opinions, in English, straight from the regulator. Answers \"latest NMPA regulatory updates\", \"what has China's drug regulator changed\", \"NMPA guidance on medical devices or cosmetics\". Returns title, publication date and the announcement URL. NOTE: this is the announcements feed, NOT the drug-approval register — it does not list which drugs were approved.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        section: {
          type: 'string',
          enum: ['news', 'drugs', 'devices', 'cosmetics'],
          description: 'Limit to one section. Omitted, all four are merged and sorted newest first.',
        },
        limit: { type: 'number', description: 'Maximum announcements, 1-40 (default 15).' },
      },
    },
  },
  {
    name: 'nmpa_drug_approvals',
    description:
      'NMPA (国家药监局) drug-APPROVAL events — a specific drug cleared for marketing, granted conditional approval, or given an expanded indication in China — as opposed to nmpa_updates, which is regulatory policy news. 批准 新药 创新药 获批上市 NMPA新药批准. Answers "latest NMPA drug approvals in China", "2026年8月NMPA批准的新药", "what new drugs did China approve this month", "recent Chinese biotech drug approvals". Sourced from HKEX (Hong Kong Exchange) disclosure filings: any Hong Kong-listed biotech announces an NMPA approval as a regulatory disclosure the same day, and that filing is public and structured. Returns the filing headline (which names the drug and often the indication), the company, the approval date, a best-effort category, and the filing PDF. Coverage is limited to HKEX-listed companies — see coverage_note in the response.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        month: { type: 'string', description: 'A single month, "YYYY-MM" (e.g. "2026-08"). Takes priority over since/until.' },
        since: { type: 'string', description: 'Earliest approval date, YYYY-MM-DD. Ignored if `month` is set.' },
        until: { type: 'string', description: 'Latest approval date, YYYY-MM-DD. Ignored if `month` is set.' },
        query: { type: 'string', description: 'Filter to filings whose headline or company name contains this text (drug name, code like "TY-9591", or company like "HUTCHMED").' },
        limit: { type: 'number', description: 'Maximum approvals to return, 1-40 (default 15).' },
      },
    },
  },
  {
    name: 'csrc_penalties',
    description:
      "Administrative penalty decisions (行政处罚决定书) from the CSRC — the China Securities Regulatory Commission, China's securities and capital-markets regulator — newest first, straight from csrc.gov.cn's own JSON feed. Each row carries the decision number (e.g. 〔2026〕42号), the publication date, the named parties from the decision's opening lines (listed companies, accounting firms, individuals sanctioned for disclosure fraud, insider trading, market manipulation), and the link to the full decision. Answers \"recent CSRC enforcement actions\", \"中国证监会最近的行政处罚\", \"which companies did China's securities regulator penalize\". This is securities-market enforcement, not drug regulation — for NMPA announcements use nmpa_updates.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'Earliest publication date, YYYY-MM-DD. Omitted, the newest decisions are returned regardless of age.' },
        page: { type: 'number', description: 'Page number, 1-based (default 1). Pages are newest-first.' },
        limit: { type: 'number', description: 'Rows per page, 1-40 (default 15).' },
      },
    },
  },
  {
    name: 'nmpa_drug_approval',
    description:
      'One NMPA drug-approval record by id (the `id` field returned by nmpa_drug_approvals) or by name (a drug name, code, or company). 单个药品批准记录. Returns the same fields as nmpa_drug_approvals for the single best-matching filing, plus the filing headline as a summary. Use nmpa_drug_approvals to browse first if you do not already have an id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The `id` field from a prior nmpa_drug_approvals result.' },
        name: { type: 'string', description: 'A drug name, drug code, or company name to search for.' },
      },
    },
  },
];

interface EftsHit {
  _id?: string;
  _source?: {
    display_names?: string[];
    file_date?: string;
    adsh?: string;
    ciks?: string[];
    file_type?: string;
  };
}

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Company name without EDGAR's "  (TICKER)  (CIK 000…)" decoration. */
export function cleanName(display: string): { name: string; ticker: string | null } {
  const ticker = /\(([A-Z]{1,6})(?:,\s*[A-Z]+)*\)\s*\(CIK/.exec(display)?.[1] ?? null;
  return { name: display.replace(/\s*\(.*$/, '').trim(), ticker };
}

/**
 * Pull the sentences that carry the deal. Each pattern is anchored on money or
 * territory language rather than on a fixed layout, because these are press
 * releases and no two are formatted alike.
 */
/**
 * The money clauses, which are not China-specific — every biopharma licensing
 * press release worldwide writes them the same way. Exported so `pharma-deals`
 * can run the identical extraction over a worldwide search instead of keeping a
 * second, drifting copy of these four regexes (fleet #1841).
 */
/**
 * `[^.]` as "any sentence character" TRUNCATES AT A DECIMAL POINT, and that
 * silently corrupts the biggest number in the deal. Measured on Nurix/Roche
 * 0001549595-26-000038: the milestone clause reads "...a $700 million upfront
 * payment and will be eligible to receive ... milestone payments for potential
 * total payments of up to $2.5 billion", and the old pattern stopped dead at
 * "$2." — so the only dollar figure left inside the clause was the UPFRONT, and
 * the milestone total came back as $700 million. A plausible number, attached to
 * the wrong term, with nothing failing. `(?:[^.]|\.(?=\d))` keeps a period that
 * is part of a number. (fleet #1841)
 */
const SENT = '(?:[^.]|\\.(?=\\s?\\d))';
/**
 * The sentence TERMINATOR has to refuse a decimal point as well, and a greedy
 * tail makes that mandatory rather than tidy. `SENT{0,150}\\.` walks 150
 * characters and then BACKTRACKS to the nearest period it can reach — which,
 * once SENT happily consumes `.0`, is the decimal point itself. Measured on
 * TScan 0001783328-26-000047: "a non-refundable, upfront payment of $30.0
 * million to the Company" came back cut to "$30." and the amount read as $30,
 * a figure with no scale word, which `money()` then correctly refused — so the
 * disclosed upfront reported as ABSENT. A lazy tail plus a terminator that
 * declines a decimal point ends the match at the real full stop.
 */
const END = '\\.(?!\\s?\\d)';

/**
 * The tail budgets are sized for LEGAL prose, not press-release prose, because
 * a budget that is too short does not truncate — it fails to match at all, and
 * the term reports as absent. TScan 0001783328-26-000047 states its upfront in
 * a 230-character sentence ("...upfront payment of $30.0 million to the
 * Company, which was received in 2023, success-based milestone payments of over
 * $500 million in the aggregate, and tiered single-digit royalty payments on
 * net sales..."), and at a 200-character tail the upfront clause matched
 * nothing while the milestone clause, budgeted 240, matched fine. The same deal
 * therefore reported a milestone total and no upfront.
 */
export const TERM_SENTENCE_PATTERNS: { key: string; re: RegExp }[] = [
  { key: 'upfront', re: new RegExp(`${SENT}{0,150}?upfront payment${SENT}{0,320}?${END}`, 'i') },
  { key: 'milestones', re: new RegExp(`${SENT}{0,120}?milestone payments?${SENT}{0,320}?${END}`, 'i') },
  { key: 'royalties', re: new RegExp(`${SENT}{0,120}?royalt(?:y|ies)${SENT}{0,280}?${END}`, 'i') },
];

const SENTENCE_PATTERNS: { key: string; re: RegExp }[] = [
  { key: 'territory', re: /[^.]{0,150}?(?:Greater China|in China|Chinese mainland|China, Hong Kong|mainland China)[^.]{0,150}\./i },
  ...TERM_SENTENCE_PATTERNS,
];

/**
 * First dollar figure in a sentence, normalised.
 *
 * Press releases write the same number four ways — "$65 million", "$25M",
 * "$1.5 billion", "$25.0M" — and a naive regex turns "$25M" into "$25 m" and
 * "$1.5" into "$1." by stopping at the decimal point. Both were in the first
 * live run.
 */
export function money(sentence: string | null): string | null {
  if (!sentence) return null;
  // A scale word or a thousands-grouped figure is REQUIRED. Without that guard
  // the pattern matched a bare "$1" out of unrelated prose and reported it as
  // an upfront payment — a wrong number, which is worse than an absent one. No
  // licensing deal is denominated in single dollars, so demanding the scale
  // costs nothing real.
  const scaled = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(billion|million|bn|mm|[mb])\b/i.exec(sentence);
  if (scaled) {
    const scale = scaled[2].toLowerCase();
    return `$${scaled[1]}${scale.startsWith('b') ? ' billion' : ' million'}`;
  }
  const grouped = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?)/.exec(sentence);
  return grouped ? `$${grouped[1]}` : null;
}

/** Numeric and the handful of named entities SEC press releases actually use.
 *  Left raw, a quote comes through as `&#8220;` and reads as corruption. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, '—');
}

/**
 * A regex window into running prose starts mid-word — the first run produced
 * "ntered into an Asset Purchase Agreement" and "ronic fibroinflammatory".
 * Trim forward to a real boundary so the caller gets a readable clause.
 */
export function trimToBoundary(s: string): string {
  const t = s.trim();
  // Prefer a sentence start; fall back to the next word boundary.
  const sentenceStart = /(?:^|[.!?•—]\s+)([A-Z“"][^]*)$/.exec(t.slice(0, 200));
  if (sentenceStart) return (sentenceStart[1] + t.slice(200)).trim();
  const wordStart = t.replace(/^\S*\s+/, '');
  return (wordStart || t).trim();
}

async function fetchBody(cik: string, adsh: string, doc: string): Promise<string | null> {
  const cikInt = String(parseInt(cik, 10));
  const accn = adsh.replace(/-/g, '');
  const res = await pwFetch(`${ARCHIVES}/${cikInt}/${accn}/${doc}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const html = await res.text();
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
}

async function searchDeals(args: Record<string, unknown>) {
  const now = new Date();
  const until = typeof args.until === 'string' && args.until ? args.until.slice(0, 10) : iso(now);
  const since =
    typeof args.since === 'string' && args.since
      ? args.since.slice(0, 10)
      : iso(new Date(now.getTime() - 90 * 86400000));
  const limit = Math.min(40, Math.max(1, (args.limit as number) ?? 10));
  const extra = typeof args.query === 'string' && args.query.trim() ? ` "${args.query.trim().replace(/"/g, '')}"` : '';

  const q = `${DEAL_TERMS} "China"${extra}`;
  const url =
    `${EFTS}?q=${encodeURIComponent(q)}&forms=8-K` +
    `&startdt=${encodeURIComponent(since)}&enddt=${encodeURIComponent(until)}`;

  const res = await pwFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`SEC full-text search error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { hits?: { total?: { value?: number }; hits?: EftsHit[] } };
  const hits = data.hits?.hits ?? [];
  const total = data.hits?.total?.value ?? 0;

  // One filing can appear several times (the 8-K and its exhibits). The
  // announcement is one deal; dedupe on the accession number.
  const seen = new Set<string>();
  const unique: EftsHit[] = [];
  for (const h of hits) {
    const adsh = h._source?.adsh;
    if (!adsh || seen.has(adsh)) continue;
    seen.add(adsh);
    unique.push(h);
  }

  const deals = [];
  for (const [i, hit] of unique.slice(0, limit).entries()) {
    const src = hit._source ?? {};
    const display = (src.display_names ?? [''])[0];
    const { name, ticker } = cleanName(display);
    const adsh = src.adsh ?? '';
    const cik = (src.ciks ?? [''])[0];
    const doc = (hit._id ?? '').split(':')[1] ?? '';

    const deal: Record<string, unknown> = {
      company: name,
      ticker,
      filed: src.file_date ?? null,
      accession: adsh,
      filing_url: cik && adsh ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${adsh.replace(/-/g, '')}/${doc}` : null,
    };

    // Detail is best-effort and bounded: the list is already an answer, and
    // every body is another SEC round-trip.
    if (i < MAX_BODIES && cik && adsh && doc) {
      const body = await fetchBody(cik, adsh, doc);
      if (body) {
        for (const { key, re } of SENTENCE_PATTERNS) {
          const m = re.exec(body);
          if (m) deal[key] = trimToBoundary(m[0]).slice(0, 400);
        }
        deal.upfront_amount = money(deal.upfront as string | null);
        deal.milestone_total = money(deal.milestones as string | null);
      } else {
        deal.detail_note = 'Filing body could not be read; the filing_url still has the announcement.';
      }
    } else if (i >= MAX_BODIES) {
      deal.detail_note = `Deal terms not extracted — only the first ${MAX_BODIES} filings are opened per call. Narrow the date window or use \`query\` to bring this one into the top ${MAX_BODIES}.`;
    }
    deals.push(deal);
  }

  if (deals.length === 0) {
    return {
      found: false,
      reason: 'no_matching_filings',
      searched: { since, until, sec_query: q },
      hint: 'No 8-K in that window announced a China licensing deal in these terms. Widen `since`, drop `query`, or note that this only sees deals with a US-listed party — a purely China-to-Japan deal will not appear here.',
    };
  }

  return {
    found: true,
    source: 'SEC EDGAR full-text search (8-K announcements)',
    searched: { since, until, sec_query: q },
    total_filings_matched: total,
    returned: deals.length,
    coverage_note:
      'Covers licensing deals with at least one SEC-filing party. A deal between two non-US-listed companies is not announced here and will be missing.',
    deals,
  };
}

/**
 * NMPA's own English announcements.
 *
 * What this is NOT, said plainly because the difference decides whether an
 * answer is right: it is not the 药品批准 approval register. That register, and
 * CDE's, sit behind a commercial JS-obfuscation WAF (瑞数/Riverdata) that
 * answers 412/202 with a challenge page to every request — verified 2026-08-11
 * from a plain non-Cloudflare client, so this is not the CF-egress problem the
 * china-stocks pack hit. Defeating it needs a headless browser, which a
 * stateless pack cannot be.
 *
 * The English mirror, by contrast, carries NO challenge at all and publishes
 * the regulator's own announcements: policy, guidance, import rules, reform
 * opinions. So this answers "what has NMPA announced / changed" and cannot
 * answer "which drugs did NMPA approve last week".
 */
const NMPA_BASE = 'https://english.nmpa.gov.cn';
const NMPA_SECTIONS: Record<string, string> = {
  news: 'news',
  drugs: 'drugs',
  devices: 'medicaldevices',
  cosmetics: 'cosmetics',
};

async function nmpaUpdates(args: Record<string, unknown>) {
  const wanted = typeof args.section === 'string' && args.section.trim()
    ? [args.section.trim().toLowerCase()]
    : Object.keys(NMPA_SECTIONS);
  const unknown = wanted.filter((w) => !NMPA_SECTIONS[w]);
  if (unknown.length) {
    throw new Error(
      `user_error: unknown section "${unknown.join(', ')}". Valid: ${Object.keys(NMPA_SECTIONS).join(', ')}.`,
    );
  }
  const limit = Math.min(40, Math.max(1, (args.limit as number) ?? 15));

  const items: Record<string, unknown>[] = [];
  const failed: string[] = [];
  for (const key of wanted) {
    const path = NMPA_SECTIONS[key];
    const res = await pwFetch(`${NMPA_BASE}/${path}.html`, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      failed.push(`${key} (HTTP ${res.status})`);
      continue;
    }
    const html = await res.text();
    // Links are RELATIVE to the section ("2026-07/10/c_1196627.htm"), which is
    // easy to miss and yields zero matches if you assume a leading slash.
    const re = /<h3 class="list-tit"><a href="([^"]+)">([\s\S]*?)<\/a><\/h3>\s*<p class="list-da[^"]*">([^<]*)<\/p>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const href = m[1].startsWith('http') ? m[1] : `${NMPA_BASE}/${m[1].replace(/^\.?\//, '')}`;
      items.push({
        section: key,
        title: decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
        published: m[3].trim() || null,
        url: href,
      });
    }
  }

  items.sort((a, b) => String(b.published ?? '').localeCompare(String(a.published ?? '')));
  const trimmed = items.slice(0, limit);

  if (trimmed.length === 0) {
    return {
      found: false,
      reason: failed.length ? 'sections_unreachable' : 'no_items_parsed',
      ...(failed.length ? { failed_sections: failed } : {}),
      hint: 'english.nmpa.gov.cn publishes as HTML; if its markup changed the parser needs updating. The Chinese-language site is behind a JS-challenge WAF and is not an alternative.',
    };
  }

  return {
    found: true,
    source: 'National Medical Products Administration (English site), english.nmpa.gov.cn',
    scope_note:
      'These are NMPA ANNOUNCEMENTS — policy, guidance, import and reform notices — not the drug-approval register. The approval register (药品批准) and CDE sit behind a JS-challenge WAF that no keyless client can read, so "which drugs were approved" is not answerable from here.',
    sections: wanted,
    ...(failed.length ? { failed_sections: failed } : {}),
    count: trimmed.length,
    updates: trimmed,
  };
}

/**
 * NMPA drug APPROVALS — as opposed to nmpa_updates' regulatory announcements.
 *
 * The obvious route — english.nmpa.gov.cn/drugs.html, which the task that
 * built this pointed at — is NOT an approvals register either, and probing
 * it live (2026-09-07) is what proves it, not just the nmpa_updates comment
 * above: every section (drugs, news, policies, regulatoryinformation) is
 * paginated administrative-policy notices ("Announcement on Strengthening
 * Supervision of Contract Manufacturing", "Policy Interpretation of..."),
 * the newest item in the `drugs` section is dated 2026-04-14 — five months
 * stale against a September run — and not one entry across any section names
 * a specific drug as approved. The Chinese nmpa.gov.cn (all paths, not just
 * `/datasearch/`) and cde.org.cn both still answer HTTP 412/202 with a
 * 瑞数-obfuscated JS challenge to a plain non-Cloudflare client, confirming
 * the 2026-08-11 finding domain-wide.
 *
 * What actually carries approval events, keyless and current: any
 * HKEX-listed Chinese biotech is required to disclose an NMPA approval as a
 * same-day regulatory filing, and HKEXnews' public title-search JSON
 * endpoint serves those filings without a key. `china_licensing_deals` above
 * uses the identical trick one exchange over (SEC 8-Ks instead of HKEX
 * filings) for the same reason: the curated register is not public, but the
 * disclosure layer is.
 *
 * TRAP, load-bearing: `titleSearchServlet.do` with `searchType=1` and a
 * non-empty `title` IGNORES `from`/`to` entirely — verified by requesting
 * three different multi-month windows (2026-01..2026-09, 2026-07 only, and a
 * single day) and getting back the identical 17-row set every time, newest
 * first. It is a rolling "most recent title-matching filings" window, not a
 * date-filtered query. So this pack always fetches the same unbounded
 * `title=NMPA` search and does its OWN date filtering client-side — asking
 * for a month before the window's start silently returns nothing genuine
 * (reported as `found: false`, not an empty success) rather than a wrong
 * empty answer read as "no approvals that month".
 */
const HKEX_TITLE_SEARCH = 'https://www1.hkexnews.hk/search/titleSearchServlet.do';
const HKEX_BASE = 'https://www1.hkexnews.hk';

interface HkexRow {
  NEWS_ID?: string;
  STOCK_NAME?: string;
  STOCK_CODE?: string;
  TITLE?: string;
  DATE_TIME?: string;
  FILE_LINK?: string;
}

/** "28/08/2026 08:00" -> "2026-08-28". Null if the format ever changes. */
function hkexDateToIso(dt: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(dt.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// A filing that MENTIONS approval language but is an IND/clinical-trial
// clearance, an application acceptance, or a designation is not a marketing
// approval — and several of these titles also contain the word "approved"
// (e.g. "APPLICATION FOR CLINICAL TRIAL ... APPROVED BY NMPA"), so exclusion
// has to be checked, not just inclusion.
const NOT_MARKETING_APPROVAL = /\b(IND\b|clinical trial|accept(ed|ance)|designation|clearance|submitted|submission)\b/i;
const IS_APPROVAL = /\b(approv(ed|al)|NDA approval)\b/i;

/**
 * Best-effort category from the headline. This is inferred from wording, not
 * an official NMPA classification the filing carries as a field — stated in
 * the response so it is not read as more authoritative than it is.
 */
function classifyApproval(title: string): { isApproval: boolean; category: string } {
  if (NOT_MARKETING_APPROVAL.test(title) || !IS_APPROVAL.test(title)) {
    return { isApproval: false, category: 'not_a_marketing_approval' };
  }
  if (/biologic|\bBLA\b/i.test(title)) return { isApproval: true, category: 'biologic' };
  if (/vaccine/i.test(title)) return { isApproval: true, category: 'vaccine' };
  if (/conditional approval/i.test(title)) return { isApproval: true, category: 'conditional_approval' };
  if (/indication/i.test(title)) return { isApproval: true, category: 'supplemental_indication' };
  return { isApproval: true, category: 'new_drug_approval' };
}

/** Fetch the HKEXnews rolling NMPA-titled filing window. See the trap note above. */
async function fetchHkexNmpaFilings(): Promise<HkexRow[]> {
  const url =
    `${HKEX_TITLE_SEARCH}?sortDir=0&sortByOptions=DateTime&category=0&market=SEHK&searchType=1` +
    `&documentType=-1&t1code=-2&t2Gcode=-2&t2code=-2&stockId=-1&from=19900101&to=99991231` +
    `&title=${encodeURIComponent('NMPA')}&lang=E`;
  const res = await pwFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw await httpError(res, 'HKEXnews title search');
  const data = (await res.json()) as { result?: string };
  if (!data.result) return [];
  try {
    return JSON.parse(data.result) as HkexRow[];
  } catch {
    throw new Error('upstream_down: HKEXnews title search returned a non-JSON `result` payload.');
  }
}

interface Approval {
  id: string;
  name_en: string;
  name_cn: string | null;
  applicant: string;
  stock_code: string | null;
  approval_date: string;
  category: string;
  notice_title: string;
  notice_url: string | null;
  source: string;
}

function toApproval(row: HkexRow): { approval: Approval; isApproval: boolean } | null {
  const rawTitle = row.TITLE;
  const dt = row.DATE_TIME;
  if (!rawTitle || !dt) return null;
  const iso = hkexDateToIso(dt);
  if (!iso) return null;
  const title = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim();
  const { isApproval, category } = classifyApproval(title);
  // Strip the "VOLUNTARY ANNOUNCEMENT -" / "INSIDE INFORMATION -" boilerplate
  // that prefixes almost every one of these filings — it is not part of the
  // drug's name, and leaving it in makes every entry start identically.
  const nameEn = title.replace(/^(VOLUNTARY ANNOUNCEMENT|INSIDE INFORMATION)\s*[-–—]?\s*/i, '').trim() || title;
  const company = row.STOCK_NAME?.trim() || 'Unknown';
  const code = row.STOCK_CODE?.trim() || null;
  return {
    isApproval,
    approval: {
      id: row.NEWS_ID ?? `${code ?? 'x'}-${iso}`,
      name_en: nameEn,
      // HKEXnews' English title search returns English-language filing
      // headlines only; the paired Chinese-language disclosure (same event,
      // different NEWS_ID) is not reliably matchable without another lookup,
      // and the PDF itself is not parsed — so this is left null rather than
      // guessed. Left explicit rather than silently omitted.
      name_cn: null,
      applicant: code ? `${company} (${code}.HK)` : company,
      stock_code: code,
      approval_date: iso,
      category,
      notice_title: title,
      notice_url: row.FILE_LINK ? `${HKEX_BASE}${row.FILE_LINK}` : null,
      source: 'HKEX filing (Hong Kong Exchange disclosure of an NMPA regulatory milestone)',
    },
  };
}

async function nmpaDrugApprovals(args: Record<string, unknown>) {
  const now = new Date();
  let since: string;
  let until: string;
  const month = typeof args.month === 'string' ? args.month.trim() : '';
  if (/^\d{4}-\d{2}$/.test(month)) {
    since = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    until = `${month}-${String(lastDay).padStart(2, '0')}`;
  } else {
    until = typeof args.until === 'string' && args.until ? args.until.slice(0, 10) : iso(now);
    since = typeof args.since === 'string' && args.since ? args.since.slice(0, 10) : iso(new Date(now.getTime() - 30 * 86400000));
  }
  const limit = Math.min(40, Math.max(1, (args.limit as number) ?? 15));
  const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim().toLowerCase() : null;

  const rows = await fetchHkexNmpaFilings();
  const windowStart = rows.length ? rows[rows.length - 1] : null;
  const windowEnd = rows.length ? rows[0] : null;

  const approvals: Approval[] = [];
  for (const row of rows) {
    const parsed = toApproval(row);
    if (!parsed || !parsed.isApproval) continue;
    const a = parsed.approval;
    if (a.approval_date < since || a.approval_date > until) continue;
    if (query && !a.name_en.toLowerCase().includes(query) && !a.applicant.toLowerCase().includes(query)) continue;
    approvals.push(a);
  }

  if (approvals.length === 0) {
    const windowNote =
      windowStart && windowEnd
        ? `The reachable window right now covers ${hkexDateToIso(windowStart.DATE_TIME ?? '') ?? '?'} to ${hkexDateToIso(windowEnd.DATE_TIME ?? '') ?? '?'} (HKEXnews' title search always returns its own most-recent-N set — see source_note); a window entirely before that start is not reachable through this source at all, which is different from there being no approvals.`
        : 'HKEXnews returned no NMPA-titled filings at all just now.';
    return {
      found: false,
      reason: 'no_matching_filings_in_window',
      searched: { since, until, query },
      hint: windowNote,
    };
  }

  return {
    found: true,
    source: 'HKEX (Hong Kong Exchange) listed-company disclosures naming an NMPA regulatory milestone',
    source_note:
      'HKEXnews’ title-search endpoint returns a rolling window of the most recent filings matching the title term, not a date-filtered query — `since`/`until`/`month` are applied by this pack after fetching, not by HKEX. History older than that rolling window (recently, roughly the last month) is not reachable through this source.',
    scope_note:
      'Covers HKEX-listed companies only (Hong Kong Main Board and GEM) that disclosed the approval under HKEX rules. A China A-share-only company, or a Chinese biotech not separately listed in Hong Kong, will not appear here even if NMPA approved its drug. `category` is inferred from the filing headline’s wording, not an official NMPA classification field.',
    searched: { since, until, query },
    count: approvals.length,
    approvals: approvals.slice(0, limit),
  };
}

async function nmpaDrugApproval(args: Record<string, unknown>) {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim().toLowerCase() : '';
  if (!id && !name) {
    throw new Error('user_error: pass either `id` (from nmpa_drug_approvals) or `name` (a drug, code or company to search for).');
  }

  const rows = await fetchHkexNmpaFilings();
  let match: Approval | null = null;
  for (const row of rows) {
    const parsed = toApproval(row);
    if (!parsed || !parsed.isApproval) continue;
    const a = parsed.approval;
    if (id && a.id === id) {
      match = a;
      break;
    }
    if (name && (a.name_en.toLowerCase().includes(name) || a.applicant.toLowerCase().includes(name))) {
      match = a;
      break;
    }
  }

  if (!match) {
    return {
      found: false,
      reason: 'no_matching_approval',
      searched: { id: id || null, name: name || null },
      hint: 'Only marketing approvals within HKEXnews’ current rolling filing window are searchable this way (see nmpa_drug_approvals’ source_note). Run nmpa_drug_approvals first to browse what is currently reachable.',
    };
  }

  return {
    found: true,
    source: match.source,
    summary: match.notice_title,
    approval: match,
  };
}

/**
 * CSRC administrative penalties (行政处罚) — the securities regulator's own
 * searchList JSON feed behind csrc.gov.cn/csrc/c101928/common_list.shtml.
 * Keyless; the Referer header is what the endpoint keys on, not a cookie or a
 * JS challenge (verified 2026-09-07 with a plain curl — unlike nmpa.gov.cn's
 * Chinese site, this one carries no 瑞数 WAF).
 *
 * Every decision is titled identically ("中国证券监督管理委员会行政处罚决定书"),
 * so the title carries nothing — the value lives in the `memo` field, whose
 * opening lines are the decision number (〔2026〕42号) and the 当事人 (named
 * parties) block. That is parsed here so callers get the violator without
 * fetching the linked content.shtml pages, which are HTML prose and are
 * deliberately NOT opened (task #1335).
 *
 * `_rangeTimeGte` filters server-side but is loose at the boundary — a
 * since=2026-08-01 request came back with a 2026-07-31 row in it (verified) —
 * so `since` is also applied client-side to the rows actually returned.
 */
const CSRC_CHANNEL = '28de6b87eda140cb93de4dd10d11867d'; // 行政处罚 channel id
const CSRC_LIST = `https://www.csrc.gov.cn/searchList/${CSRC_CHANNEL}`;
const CSRC_REFERER = 'https://www.csrc.gov.cn/csrc/c101928/common_list.shtml';

interface CsrcRow {
  title?: string;
  memo?: string;
  url?: string;
  publishedTimeStr?: string;
}

async function csrcPenalties(args: Record<string, unknown>) {
  const since = typeof args.since === 'string' && /^\d{4}-\d{2}-\d{2}/.test(args.since.trim())
    ? args.since.trim().slice(0, 10)
    : null;
  const page = Math.max(1, Math.floor((args.page as number) ?? 1));
  const limit = Math.min(40, Math.max(1, (args.limit as number) ?? 15));

  const url =
    `${CSRC_LIST}?_isAgg=true&_isJson=true&_pageSize=${limit}&_template=index` +
    `&_rangeTimeGte=${encodeURIComponent(since ?? '')}&_channelName=&page=${page}`;
  const res = await pwFetch(url, { headers: { 'User-Agent': UA, Referer: CSRC_REFERER, Accept: 'application/json' } });
  if (!res.ok) throw await httpError(res, 'CSRC penalties feed');
  const data = (await res.json()) as { data?: { total?: number; results?: CsrcRow[] } };
  const rows = data.data?.results ?? [];
  const total = data.data?.total ?? 0;

  const penalties = [];
  for (const row of rows) {
    const published = row.publishedTimeStr?.slice(0, 10) ?? null;
    if (since && published && published < since) continue;
    // memo opens with "〔2026〕42号\n\n当事人:元道通信股份有限公司(...),住所:...。"
    const memo = (row.memo ?? '').replace(/\r/g, '').trim();
    const decisionNumber = /〔\d{4}〕\d+号/.exec(memo)?.[0] ?? null;
    // First party: the text after 当事人 up to the first full-width comma or
    // sentence end. Decisions with several parties list the rest on following
    // lines — the memo excerpt carries those, this field names only the first.
    const partyMatch = /当事人[::]\s*([^,,。\n]+)/.exec(memo);
    const href = row.url ?? '';
    penalties.push({
      title: (row.title ?? '').trim(),
      decision_number: decisionNumber,
      first_party: partyMatch ? partyMatch[1].trim() : null,
      published,
      url: href ? (href.startsWith('//') ? `https:${href}` : href) : null,
      memo_excerpt: memo ? memo.replace(/\s+/g, ' ').slice(0, 300) : null,
    });
  }

  if (penalties.length === 0) {
    return {
      found: false,
      reason: 'no_penalties_in_window',
      searched: { since, page, limit },
      total_matched: total,
      hint: since
        ? 'No penalty decisions published on or after that date on this page. The feed is newest-first — drop `since` or lower `page`.'
        : 'The CSRC feed returned no rows at all, which is an upstream problem, not an empty register — there are thousands of decisions.',
    };
  }

  return {
    found: true,
    source: 'China Securities Regulatory Commission (证监会) administrative-penalty channel, csrc.gov.cn',
    scope_note:
      'These are CSRC securities-enforcement decisions (行政处罚决定书) — disclosure fraud, insider trading, market manipulation, audit failures — in Chinese. Titles are the regulator’s fixed boilerplate; the parties are in first_party/memo_excerpt and the full decision is at `url`. first_party is the first named party only; multi-party decisions list the rest in the linked decision.',
    searched: { since, page, limit },
    total_matched: total,
    count: penalties.length,
    penalties,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'china_licensing_deals':
      return searchDeals(args);
    case 'nmpa_updates':
      return nmpaUpdates(args);
    case 'nmpa_drug_approvals':
      return nmpaDrugApprovals(args);
    case 'nmpa_drug_approval':
      return nmpaDrugApproval(args);
    case 'csrc_penalties':
      return csrcPenalties(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
