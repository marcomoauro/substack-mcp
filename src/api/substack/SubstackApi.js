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

  /**
   * Turns a failing status into an error and a successful one into its raw body text.
   *
   * Split out of handleResponse so the text and JSON paths share one refusal branch: the subscriber
   * export answers with CSV, and a 403 there must still throw rather than hand the parser an error
   * page to read as rows.
   */
  static async readBody(response) {
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

    return response.text();
  }

  static async handleResponse(response) {
    const text = await SubstackApi.readBody(response);
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
   *
   * `parse: 'text'` returns the raw body instead, for the endpoints that do not answer JSON.
   */
  async request({method, path, ...options}) {
    return this.requestUrl({url: `${this.publication_url}${path}`, method, ...options});
  }

  /**
   * The same as `request`, but against `substack.com/api/v1` instead of the publication host.
   *
   * Substack splits its API across two hosts and the split is not cosmetic: the publisher surface
   * (drafts, subscribers, stats) lives on the publication, while everything about *you as a
   * person* — your profile, your subscriptions, the reader feed, Notes and comment threads — lives
   * on substack.com and is keyed by user id rather than publication id. Calling one on the other's
   * host answers 404, so which base a method uses is part of the endpoint, not a detail.
   */
  async requestGlobal({method, path, ...options}) {
    return this.requestUrl({url: `${this.base_url}${path}`, method, ...options});
  }

  /**
   * The same as `request`, but taking an absolute url.
   *
   * Needed because the subscriber export answers with a url relative to the publication *host*
   * (`/api/v1/subscriber_set/export/…`), which cannot be appended to `publication_url` — that
   * already ends in `/api/v1` and the result would be `/api/v1/api/v1/…`.
   */
  async requestUrl({
    method,
    url: rawUrl,
    body = null,
    params = null,
    referer = '/publish/posts',
    parse = 'json',
  }) {
    const target = new URL(rawUrl);

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

    return parse === 'text'
      ? SubstackApi.readBody(response)
      : SubstackApi.handleResponse(response)
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

  /**
   * Applies a partial update to a draft: only the keys present in `body` change, the rest are left
   * as they are. Verified against the live API — a PUT carrying nothing but `draft_title` and
   * `draft_subtitle` updated exactly those two and preserved the body.
   */
  async updateDraft(draft_id, body) {
    return this.request({
      method: 'PUT',
      path: `/drafts/${draft_id}`,
      body,
      referer: '/publish/post',
    });
  }

  /**
   * Deletes a draft. The endpoint is shared with published posts — the same DELETE removes one —
   * which is why `delete_draft` refuses an `is_published` target rather than exposing that reach.
   */
  async deleteDraft(draft_id) {
    return this.request({
      method: 'DELETE',
      path: `/drafts/${draft_id}`,
      referer: '/publish/posts',
    });
  }

  /**
   * Publishes a draft. `send` controls whether subscribers get the email — the irreversible half of
   * the operation, since an email cannot be recalled once out.
   *
   * The request is UNVERIFIED (confirming it means publishing something real), but the path and the
   * `send` key are not guesses: the dashboard bundle builds this exact call as
   * `post('/api/v1/drafts/' + id + '/publish').send({send: true, only_send: true})`, where
   * `only_send` means "email an already-published post without republishing it".
   *
   * `share_automatically` — which the fork this was ported from sent — appears **zero** times in that
   * bundle and is not sent here. An unexpected parameter is a 400 on several of this API's endpoints,
   * so an invented key risks breaking the call outright.
   *
   * Whether the *initial* publish honours a body `send` or reads the draft's own
   * `should_send_email` could not be determined without publishing, and that ambiguity is dangerous
   * in one direction only: `should_send_email` is `true` by default on a real draft, so a body `send`
   * that turns out to be ignored would mail the whole list. `publish_draft` therefore writes the
   * intent to the draft first and passes `send` as well — see the tool.
   */
  async publishDraft(draft_id, {send = true} = {}) {
    return this.request({
      method: 'POST',
      path: `/drafts/${draft_id}/publish`,
      body: {send},
      referer: '/publish/post',
    });
  }

  async getPublication() {
    return this.request({method: 'GET', path: '/publication', referer: '/publish/settings'});
  }

  /**
   * Every tag defined on the publication, as `{id, publication_id, name, slug, hidden}`.
   *
   * The path is `/publication/post-tag`, not `/post_tags` — that one answers 404. GET lists and POST
   * creates on the same path. Note the id is a **UUID string**, not an integer like every other id
   * in this API, which is what makes `add_tag_to_post` take a name rather than an id.
   */
  async getPostTags() {
    return this.request({
      method: 'GET',
      path: '/publication/post-tag',
      referer: '/publish/settings',
    });
  }

  /**
   * The tags currently on one post. Neither `GET /drafts/:id` nor `post_management/*` carries them —
   * verified — so this is the only way to read back what `addTagToPost` did.
   */
  async getTagsForPost(post_id) {
    return this.request({
      method: 'GET',
      path: `/post/${post_id}/tag`,
      referer: '/publish/post',
    });
  }

  /**
   * Creates a tag on the publication. UNVERIFIED: the path is confirmed by the GET above answering
   * on it, but firing the POST would leave a tag behind on a real publication.
   */
  async createPostTag(name) {
    return this.request({
      method: 'POST',
      path: '/publication/post-tag',
      body: {name},
      referer: '/publish/settings',
    });
  }

  /**
   * Attaches an existing tag to a post. Verified: answers with the join row —
   * `{publication_id, post_id, post_tag_id, id}` — where `id` is the association's own UUID, distinct
   * from `post_tag_id`. Works on drafts as well as published posts.
   */
  async addTagToPost(post_id, post_tag_id) {
    return this.request({
      method: 'POST',
      path: `/post/${post_id}/tag/${post_tag_id}`,
      referer: '/publish/post',
    });
  }

  /**
   * One page of the accounts you subscribe to, on substack.com.
   *
   * `items` is **heterogeneous**: alongside `type: 'subscription'` it carries `type: 'label'`
   * (section headers like "Paid") and `type: 'add_more'` (a UI affordance). Treating the array as a
   * list of subscriptions yields entries with no publication at all, so the caller must filter.
   */
  async listSubscriptions({cursor = null, limit = 100} = {}) {
    return this.requestGlobal({
      method: 'GET',
      path: '/subscriptions/all/v2',
      params: {limit, cursor},
      referer: '/',
    });
  }

  /**
   * The reader Inbox: recent posts from the publications you subscribe to.
   *
   * Paging is not a cursor — the top-level `cursor` is null. It is `after`, and the value comes from
   * the last entry of `inboxItems`, whose `content_date` is the timestamp to resume from.
   */
  async listReaderPosts({limit = 20, after = null} = {}) {
    return this.requestGlobal({
      method: 'GET',
      path: '/reader/posts',
      params: {limit, after},
      referer: '/inbox',
    });
  }

  /**
   * One post by id, from any publication — answers `{post, publication, publicationSettings}`.
   *
   * This is the only endpoint that returns the *body* of someone else's post. Verified against a
   * live post: `post.body_html` came back complete at ~22 KB.
   */
  async getPostById(post_id) {
    return this.requestGlobal({
      method: 'GET',
      path: `/posts/by-id/${post_id}`,
      referer: '/inbox',
    });
  }

  /** The Notes/posts feed. `tab` is an id from `getReaderFeedTabs`, e.g. 'for-you' or 'subscribed'. */
  async getReaderFeed({tab = 'for-you', cursor = null, limit = 20} = {}) {
    return this.requestGlobal({
      method: 'GET',
      path: '/reader/feed',
      params: {tab, cursor, limit},
      referer: '/notes',
    });
  }

  /**
   * The available feed tabs. Note the `name` of each is **localized** to the account's language —
   * observed coming back in Italian — so a tab must be selected by `id`, never by name.
   */
  async getReaderFeedTabs() {
    return this.requestGlobal({method: 'GET', path: '/reader/feed/tabs', referer: '/notes'});
  }

  /** One user's own feed: the Notes they wrote and the posts they published. */
  async getProfileFeed(user_id, {cursor = null, limit = 20} = {}) {
    return this.requestGlobal({
      method: 'GET',
      path: `/reader/feed/profile/${user_id}`,
      params: {cursor, limit},
      referer: '/profile',
    });
  }

  /** One Note or comment, as `{item}`. */
  async getComment(comment_id) {
    return this.requestGlobal({
      method: 'GET',
      path: `/reader/comment/${comment_id}`,
      referer: '/notes',
    });
  }

  /**
   * The reply branches under a Note or comment, as
   * `{rootComment, commentBranches, moreBranches, nextCursor}`.
   */
  async getCommentReplies(comment_id, {cursor = null} = {}) {
    return this.requestGlobal({
      method: 'GET',
      path: `/reader/comment/${comment_id}/replies`,
      params: {cursor},
      referer: '/notes',
    });
  }

  /**
   * Restacks a post or a Note to your own followers.
   *
   * UNVERIFIED: this publishes to your profile, and confirming it means leaving a real restack
   * behind. Path and body come from the dashboard's own traffic as read by the fork.
   */
  async restackFeedItem({post_id = null, comment_id = null, tab_id = 'for-you'} = {}) {
    return this.requestGlobal({
      method: 'POST',
      path: '/restack/feed',
      body: {
        ...(post_id === null ? {} : {postId: Number(post_id)}),
        ...(comment_id === null ? {} : {commentId: Number(comment_id)}),
        tabId: tab_id,
      },
      referer: '/notes',
    });
  }

  /**
   * The comments on one of your posts. Answers `{comments, automod_hidden_comments}` — the second
   * array is the ones Substack's automod withheld, which never appear in the first.
   */
  async getPostComments(post_id, {limit = 50} = {}) {
    return this.request({
      method: 'GET',
      path: `/post/${post_id}/comments`,
      params: {limit},
      referer: '/publish/post',
    });
  }

  /**
   * Posts a comment on one of your posts, as you. UNVERIFIED: confirming it means leaving a public
   * comment on a real post.
   */
  async commentOnPost(post_id, body) {
    return this.request({
      method: 'POST',
      path: `/post/${post_id}/comment`,
      body: {body},
      referer: '/publish/post',
    });
  }

  /**
   * Your own account, on substack.com rather than the publication: id, handle, bio, and the
   * `publicationUsers` list that names every publication you have a role on.
   */
  async getUserProfile() {
    return this.requestGlobal({method: 'GET', path: '/user/profile/self', referer: '/'});
  }

  /**
   * Creates a subscriber set — a server-side handle on a group of subscribers, addressed either by
   * the same `filters` object the subscribers list uses or by explicit user ids.
   *
   * The set id is the input to two different operations: exporting the group, and bulk-tagging it.
   */
  async createSubscriberSet(query, user_ids = null) {
    return this.request({
      method: 'POST',
      path: '/subscriber_set',
      body: user_ids ? {user_ids} : {query},
      referer: '/publish/subscribers',
    });
  }

  /**
   * Asks for an export of a subscriber set and returns its `export_id`.
   *
   * `columns` is the list of column keys wanted in the CSV. Unsupported ones are dropped
   * **silently** rather than refused — `group_membership` and `tag_ids` do not come back — so the
   * caller has to compare what it asked for against the header it got.
   */
  async requestSubscriberSetExport({subscriber_set_id, columns}) {
    return this.request({
      method: 'POST',
      path: '/subscriber_set/export',
      body: {subscriberSetId: subscriber_set_id, columns},
      referer: '/publish/subscribers',
    });
  }

  /**
   * Polls one export. Answers `{url}` once the file is ready; the url is absent while it is still
   * being generated.
   */
  async getSubscriberSetExport(export_id) {
    return this.request({
      method: 'GET',
      path: `/subscriber_set/export/${export_id}`,
      referer: '/publish/subscribers',
    });
  }

  /**
   * Downloads a finished export as raw CSV text.
   *
   * The url handed back by the export is relative to the publication host and authenticated by the
   * same session cookie — it is not pre-signed, and fetching it without the cookie is a 403.
   */
  async downloadExport(url) {
    return this.requestUrl({
      method: 'GET',
      url: new URL(url, this.hostname).toString(),
      parse: 'text',
      referer: '/publish/subscribers',
    });
  }
}
