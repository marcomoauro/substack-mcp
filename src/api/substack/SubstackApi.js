import axios from 'axios';

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

    this.session = axios;
  }

  static handleResponse(response) {
    if (!(response.status >= 200 && response.status < 300)) {
      throw new Error(`SubstackAPIException: ${response.status} ${response.statusText}`);
    }

    try {
      return response.data;
    } catch (error) {
      throw new Error(`SubstackRequestException: Invalid Response: ${response.data}`);
    }
  }

  async postDraft(body) {
    const url = `${this.publication_url}/drafts`;

    const headers = {};
    headers['Cookie'] = this.auth_cookie;
    headers['referer'] = `${this.hostname}/publish/post`;

    const response = await this.session.post(url, body, {headers})
    return SubstackApi.handleResponse(response)
  }
}