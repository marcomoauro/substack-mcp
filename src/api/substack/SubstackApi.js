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

  async postDraft(body) {
    const url = `${this.publication_url}/drafts`;

    const headers = {};
    headers['Content-Type'] = 'application/json';
    headers['Cookie'] = this.auth_cookie;
    headers['referer'] = `${this.hostname}/publish/post`;

    const startedAt = Date.now();
    // `headers` carries the session cookie: the logger redacts it by key name.
    logger.info('substack.request', {method: 'POST', url, headers, body});

    let response;

    try {
      response = await fetch(url, {method: 'POST', headers, body: JSON.stringify(body)});
    } catch (error) {
      // fetch only rejects on a transport failure — DNS, TLS, connection reset. A non-2xx
      // answer resolves, and is handled by handleResponse below.
      logger.error('substack.request.failed', {
        method: 'POST',
        url,
        duration_ms: Date.now() - startedAt,
        error,
      });
      throw error;
    }

    logger.info('substack.response', {
      method: 'POST',
      url,
      status: response.status,
      duration_ms: Date.now() - startedAt,
    });

    return SubstackApi.handleResponse(response)
  }
}
