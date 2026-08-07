import {logger} from "../../logger.js";

export default class SubstackApi {
  constructor({
                email = null,
                password = null,
                base_url = null,
                publication_url = null,
                auth_token = null
              }) {
    this.email = email;
    this.password = password;
    this.base_url = base_url || 'https://substack.com/api/v1';
    this.publication_url = new URL('api/v1', publication_url).toString();
    this.hostname = publication_url
    this.auth_cookie = `substack.sid=${auth_token}; connect.sid=${auth_token};`

    logger.debug('substack_api.created', {
      base_url: this.base_url,
      publication_url: this.publication_url,
      hostname: this.hostname,
      // The token itself never gets logged; whether one arrived at all is the diagnosis.
      has_auth_token: Boolean(auth_token),
    });
  }

  static async handleResponse(response) {
    if (!response.ok) {
      // Substack explains the refusal in the body, and the thrown message carries only the
      // status. Reading it here is what makes a 400 debuggable at all.
      const body = await response.text().catch(() => '<unreadable body>');
      logger.error('substack.response.error', {
        status: response.status,
        statusText: response.statusText,
        body,
      });

      throw new Error(`SubstackAPIException: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      logger.error('substack.response.invalid', {status: response.status, body: text});
      throw new Error(`SubstackRequestException: Invalid Response: ${text}`);
    }

    logger.debug('substack.response.body', {status: response.status, body: parsed});
    return parsed;
  }

  /**
   * Issues one authenticated request against the publication API and returns the parsed body.
   *
   * `path` is relative to `/api/v1` (`/drafts`, `/subscriber-stats`). `params` become the query
   * string, with null and undefined entries dropped rather than serialized — a `query=null` in
   * the URL is a search for the literal string "null", which silently returns nothing.
   */
  async request({method, path, body = null, params = null, referer = '/publish/posts'}) {
    const target = new URL(`${this.publication_url}${path}`);

    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== null && value !== undefined) target.searchParams.set(key, value);
    }

    const url = target.toString();

    const headers = {};
    if (body !== null) headers['Content-Type'] = 'application/json';
    headers['Cookie'] = this.auth_cookie;
    headers['referer'] = `${this.hostname}${referer}`;

    const startedAt = Date.now();
    // `headers` carries the session cookie: the logger redacts it by key name.
    logger.info('substack.request', {method, url, headers, body});

    let response;

    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body === null ? {} : {body: JSON.stringify(body)}),
      });
    } catch (error) {
      // fetch only rejects on a transport failure — DNS, TLS, connection reset. A non-2xx
      // answer resolves, and is handled by handleResponse below.
      logger.error('substack.request.failed', {
        method,
        url,
        duration_ms: Date.now() - startedAt,
        error,
      });
      throw error;
    }

    logger.info('substack.response', {
      method,
      url,
      status: response.status,
      duration_ms: Date.now() - startedAt,
    });

    return SubstackApi.handleResponse(response)
  }

  async postDraft(body) {
    return this.request({method: 'POST', path: '/drafts', body, referer: '/publish/post'});
  }

  /**
   * Lists subscribers. `query` is the whole request body — filters, sorting and free-text search
   * all live inside its `filters` object; see SubscriberQuery.js for how it is assembled.
   */
  async getSubscribers(query) {
    return this.request({
      method: 'POST',
      path: '/subscriber-stats',
      body: query,
      referer: '/publish/subscribers',
    });
  }

  /**
   * Lists posts for one status: 'drafts', 'published' or 'scheduled'. `order_by` is not optional
   * on the API side for every status — 'scheduled' answers 400 without it — so the caller is
   * expected to always pass one.
   */
  async getPosts({status, limit, offset, order_by, order_direction, query = null}) {
    return this.request({
      method: 'GET',
      path: `/post_management/${status}`,
      params: {offset, limit, order_by, order_direction, query},
      referer: '/publish/posts',
    });
  }

  async getDraft(draft_id) {
    return this.request({method: 'GET', path: `/drafts/${draft_id}`, referer: '/publish/post'});
  }
}
