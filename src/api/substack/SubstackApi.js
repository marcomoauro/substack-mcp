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
  }

  static async handleResponse(response) {
    if (!response.ok) {
      throw new Error(`SubstackAPIException: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`SubstackRequestException: Invalid Response: ${text}`);
    }
  }

  async postDraft(body) {
    const url = `${this.publication_url}/drafts`;

    const headers = {};
    headers['Content-Type'] = 'application/json';
    headers['Cookie'] = this.auth_cookie;
    headers['referer'] = `${this.hostname}/publish/post`;

    const response = await fetch(url, {method: 'POST', headers, body: JSON.stringify(body)});
    return SubstackApi.handleResponse(response)
  }
}
