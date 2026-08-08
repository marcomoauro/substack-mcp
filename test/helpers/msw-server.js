import {setupServer} from 'msw/node';
import {http, HttpResponse} from 'msw';
import {TEST_ENV} from './env.js';

const API = `${TEST_ENV.SUBSTACK_PUBLICATION_URL}/api/v1`;

// Substack's second host. The publisher surface lives on the publication, but your profile, your
// subscriptions, the reader feed and Notes are all keyed by user rather than publication and answer
// only here — so a test that mocks the wrong base gets an unhandled-request failure, by design.
const GLOBAL_API = 'https://substack.com/api/v1';

export const DRAFTS_URL = `${API}/drafts`;
export const IMAGE_URL = `${API}/image`;
export const PUBLICATION_URL = `${API}/publication`;
export const USER_PROFILE_URL = `${GLOBAL_API}/user/profile/self`;
export const POST_TAG_URL = `${API}/publication/post-tag`;
export const POST_URL = `${API}/post`;
export const SUBSCRIPTIONS_URL = `${GLOBAL_API}/subscriptions/all/v2`;
export const READER_POSTS_URL = `${GLOBAL_API}/reader/posts`;
export const POST_BY_ID_URL = `${GLOBAL_API}/posts/by-id`;
export const READER_FEED_URL = `${GLOBAL_API}/reader/feed`;
export const READER_FEED_TABS_URL = `${GLOBAL_API}/reader/feed/tabs`;
export const READER_COMMENT_URL = `${GLOBAL_API}/reader/comment`;
export const RESTACK_URL = `${GLOBAL_API}/restack/feed`;
export const SUBSCRIBER_STATS_URL = `${API}/subscriber-stats`;
export const POST_MANAGEMENT_URL = `${API}/post_management`;
export const DASHBOARD_SUMMARY_URL = `${API}/publish-dashboard/summary`;
export const OPEN_RATE_URL = `${API}/publication/stats/email_stats/30d_open_rate`;
export const VIEWS_30D_URL = `${API}/publication/stats/publication_traffic/30d_views`;
export const SUBSCRIBER_SET_URL = `${API}/subscriber_set`;
export const SUBSCRIBER_SET_EXPORT_URL = `${API}/subscriber_set/export`;

export const SUBSCRIBER_SET_ID = 1135508;
export const EXPORT_ID = 'test-export-id';

// The export answers with a *relative* url on the publication host, cookie-authenticated — not a
// pre-signed one. Verified against the live API: fetching it without the session cookie is a 403.
export const EXPORT_FILE_PATH = `/api/v1/subscriber_set/export/${EXPORT_ID}/subscribers.csv`;
export const EXPORT_FILE_URL = `${TEST_ENV.SUBSTACK_PUBLICATION_URL}${EXPORT_FILE_PATH}`;

/**
 * A CSV shaped exactly like a real export: the header carries human LABELS rather than column keys,
 * the server's own column order (not the requested one), a quoted currency value instead of a
 * number, and a name containing a comma — the case a `split(',')` gets wrong.
 */
export const EXPORT_CSV = [
  'Email,Name,Start date,Emails opened (30d),Post views,Revenue,Activity,Country',
  'one@example.com,One,2026-07-29T22:07:50.299Z,2,1,"€0.00",5,BR',
  'two@example.com,"Two, Junior",2026-06-01T10:00:00.000Z,0,7,"€50.00",3,IT',
].join('\n');

export const DRAFT_RESPONSE = {
  id: 167712345,
  draft_title: 'Test title',
  draft_subtitle: 'Test subtitle',
  is_published: false,
};

// These are the exact keys the live `POST /api/v1/image` endpoint returned, verified 2026-08-08.
export const IMAGE_UPLOAD_RESPONSE = {
  id: 'test-image-id',
  url: 'https://substack-post-media.s3.amazonaws.com/public/images/test-image.jpg',
  contentType: 'image/jpeg',
  bytes: 82768,
  imageWidth: 1200,
  imageHeight: 630,
};

// Shaped after a real `POST /drafts/:id/publish`: the draft comes back as a post, with the slug and
// canonical url it did not have while unpublished.
export const PUBLISHED_POST_RESPONSE = {
  id: 167712345,
  title: 'Test title',
  slug: 'test-title',
  canonical_url: 'https://test.substack.com/p/test-title',
  is_published: true,
};

// Trimmed from a real 111-field response. Deliberately includes a `*_email_disabled` toggle and an
// HTML blob: they are what the projection in get_publication exists to keep out of an LLM's context,
// so a test asserting the projection needs them present to prove they were dropped.
export const PUBLICATION_RESPONSE = {
  id: 2150088,
  name: 'Test Publication',
  subdomain: 'test',
  custom_domain: null,
  hero_text: 'A test publication',
  copyright: 'Test Author',
  email_from_name: 'Test Author',
  logo_url: 'https://example.com/logo.png',
  cover_photo_url: null,
  author_name: 'Test Author',
  created_at: '2024-01-01T00:00:00.000Z',
  language: 'en',
  payments_state: 'enabled',
  plans: [],
  community_enabled: true,
  moderation_enabled: false,
  podcast_enabled: false,
  is_personal_mode: false,
  invite_only: false,
  paused: false,
  post_reaction_email_disabled: true,
  tos_content: '<p>Terms of service boilerplate</p>',
  welcome_email_content: '<p>Welcome!</p>',
};

// Tag ids are UUIDs, unlike every other id in this API — an integer here would make the specs pass
// against a shape the server never sends.
export const POST_TAGS_RESPONSE = [
  {id: 'b0f9ee7d-c995-4d18-9b2f-2bcf261a1a63', publication_id: 2150088, name: 'alarms', slug: 'alarms', hidden: false},
  {id: '58e5c27e-b4fd-4d0b-b461-be5cd94c84bf', publication_id: 2150088, name: 'Automation', slug: 'automation', hidden: false},
  {id: 'c1111111-1111-1111-1111-111111111111', publication_id: 2150088, name: 'internal', slug: 'internal', hidden: true},
];

// What `GET /post/:id/tag` really answers: join rows, with no name and no slug. The whole reason
// get_post_tags costs a second request.
export const POST_TAG_ASSOCIATIONS_RESPONSE = [
  {
    id: 'd6131d6f-7aa6-4c62-846e-cbbeee0252d1',
    publication_id: 2150088,
    post_id: 167712345,
    post_tag_id: '58e5c27e-b4fd-4d0b-b461-be5cd94c84bf',
  },
];

/**
 * A comment as the API really sends one. Author fields are flat rather than nested under `user`,
 * replies are a `children_count` rather than an array, and hierarchy is the dot-separated
 * `ancestor_path` — the three things the fork got wrong by analogy.
 *
 * `ancestor_path` values here are the ones observed live: '' at the root, then the parent id, then
 * grandparent.parent.
 */
export const POST_COMMENTS_RESPONSE = {
  comments: [
    {
      id: 309007328,
      name: 'Top Level',
      handle: 'toplevel',
      user_id: 22563751,
      body: 'A top-level comment',
      body_json: {type: 'doc', content: []},
      post_id: 167712345,
      publication_id: 2150088,
      date: '2026-08-01T10:00:00.000Z',
      edited_at: null,
      ancestor_path: '',
      reaction_count: 3,
      restacks: 1,
      children_count: 2,
      attachments: [],
    },
    {
      id: 309403526,
      name: 'First Reply',
      handle: 'reply1',
      user_id: 41640433,
      body: 'A reply',
      post_id: 167712345,
      publication_id: 2150088,
      date: '2026-08-01T11:00:00.000Z',
      ancestor_path: '309007328',
      reaction_count: 0,
      children_count: 1,
      attachments: [{id: 1}],
    },
    {
      id: 309469354,
      name: 'Nested Reply',
      handle: 'reply2',
      user_id: 99,
      body: 'A reply to the reply',
      post_id: 167712345,
      publication_id: 2150088,
      date: '2026-08-01T12:00:00.000Z',
      ancestor_path: '309007328.309403526',
      reaction_count: 0,
      children_count: 0,
      attachments: [],
    },
  ],
  // Never merged into `comments`: these are the ones automod withheld.
  automod_hidden_comments: [{id: 999, body: 'spam'}],
};

/**
 * `GET /subscriptions/all/v2`. `items` is heterogeneous — three types were observed live and only
 * `subscription` carries a publication. The `label` and `add_more` entries are here so a spec can
 * prove they are filtered out rather than turned into nameless subscriptions.
 *
 * `paused: null` rather than false is the real shape, and the far-future `expiry` on a free
 * subscription is too — which is why an expiry alone does not mean a paid term.
 */
export const SUBSCRIPTIONS_RESPONSE = {
  items: [
    {type: 'label', text: 'Paid', trackingParameters: null},
    {
      id: 1,
      type: 'subscription',
      pub: {id: 5152101, subdomain: 'refactoring', name: 'Refactoring', base_url: 'https://refactoring.fm', author_name: 'Luca'},
      primaryProfile: {name: 'Luca Rossi'},
      subscription: {
        id: 111,
        membership_state: 'subscribed',
        type: 'free',
        paused: null,
        expiry: '2121-10-24T19:50:43.886Z',
        is_favorite: false,
        is_founding: false,
        email_disabled: false,
      },
    },
    {
      id: 2,
      type: 'subscription',
      pub: {id: 2222, subdomain: 'paused-pub', name: 'A Paused One', base_url: 'https://paused.substack.com'},
      subscription: {id: 222, membership_state: 'subscribed', type: 'free', paused: true, expiry: null},
    },
    {
      id: 3,
      type: 'subscription',
      pub: {id: 3333, subdomain: 'expired-pub', name: 'An Expired One', base_url: 'https://expired.substack.com'},
      subscription: {id: 333, membership_state: 'expired', type: 'paid', paused: null, expiry: '2020-01-01T00:00:00.000Z'},
    },
    {type: 'add_more'},
  ],
  nextCursor: null,
};

/**
 * `GET /reader/posts` — the Inbox. Each post really does arrive with `body_html` and `body_json`
 * attached, which is why the listing is projected; the fixture carries them so a spec can prove they
 * are dropped. Paging is `after`, taken from the last `inboxItems` entry's `content_date` — the
 * top-level `cursor` is null on this endpoint.
 */
export const READER_POSTS_RESPONSE = {
  posts: [
    {
      id: 205705837,
      publication_id: 5152101,
      title: 'REST API Authentication Methods Clearly Explained',
      subtitle: 'A subtitle',
      type: 'newsletter',
      post_date: '2026-08-05T18:25:08.238Z',
      audience: 'everyone',
      canonical_url: 'https://blog.levelupcoding.com/p/rest-api-authentication-methods',
      wordcount: 1200,
      reaction_count: 40,
      comment_count: 3,
      restacks: 5,
      is_viewed: true,
      read_progress: 0.5,
      is_saved: false,
      publishedBylines: [{name: 'The Author'}],
      body_html: '<p>The whole post body, tens of KB in reality</p>',
      body_json: {type: 'doc', content: []},
      truncated_body_text: 'The whole post body…',
    },
  ],
  publications: [{id: 5152101, name: 'Level Up Coding'}],
  more: true,
  inboxItems: [{content_date: '2026-08-05T07:01:55.441Z'}],
  cursor: null,
};

// `GET /posts/by-id/:id` — the only endpoint that returns another publication's post body.
export const POST_BY_ID_RESPONSE = {
  post: {
    id: 204305990,
    title: 'A Post From Someone Else',
    subtitle: 'With a subtitle',
    post_date: '2026-08-01T10:00:00.000Z',
    canonical_url: 'https://alexpozzi.substack.com/p/a-post',
    audience: 'everyone',
    wordcount: 900,
    reaction_count: 12,
    comment_count: 4,
    restacks: 2,
    publishedBylines: [{name: 'Alex Pozzi'}],
    body_html: '<p>The body of someone else’s post</p>',
    truncated_body_text: 'The body of someone…',
  },
  publication: {id: 987, name: 'Alex’s Publication', subdomain: 'alexpozzi'},
  publicationSettings: {},
};

/**
 * `GET /reader/feed`. Three item types, only two of which carry content — `userSuggestions` is a
 * "people to follow" block with no id, no author and no body. It is in the fixture so a spec can
 * prove it is dropped rather than summarized into an empty entry.
 */
export const READER_FEED_RESPONSE = {
  items: [
    {
      entity_key: 'c-306029118',
      type: 'comment',
      context: {type: 'note', timestamp: '2026-08-07T10:03:00.251Z', model_score: 0.9, scores: {}},
      publication: {name: 'Someone’s Publication'},
      comment: {
        id: 306029118,
        name: 'Stephane Moreau',
        handle: 'stephane',
        user_id: 22563751,
        body: 'Every engineering team wants more autonomy.',
        body_json: {type: 'doc', content: []},
        post_id: null,
        date: '2026-08-07T10:03:00.251Z',
        ancestor_path: '',
        reaction_count: 1,
        children_count: 0,
        attachments: [],
      },
      parentComments: [],
      canReply: true,
    },
    {
      entity_key: 'p-204305990',
      type: 'post',
      context: {type: 'post', timestamp: '2026-07-06T15:48:06.672Z'},
      publication: {name: 'Alex’s Publication'},
      post: {
        id: 204305990,
        title: 'A Feed Post',
        subtitle: null,
        publication_id: 987,
        post_date: '2026-07-06T15:48:06.672Z',
        canonical_url: 'https://alexpozzi.substack.com/p/a-post',
        audience: 'everyone',
        reaction_count: 8,
        comment_count: 1,
        restacks: 0,
        publishedBylines: [{name: 'Alex Pozzi'}],
        truncated_body_text: 'A teaser…',
        body_html: '<p>should be dropped from a feed listing</p>',
      },
    },
    {type: 'userSuggestions', userSuggestions: [{id: 1}, {id: 2}]},
  ],
  nextCursor: 'next-page-cursor',
};

// Names are localized — these came back in Italian on a live account — so a tab is selected by id.
export const READER_FEED_TABS_RESPONSE = {
  tabs: [
    {id: 'for-you', name: 'Per te', type: 'base'},
    {id: 'subscribed', name: 'Segui già', type: 'secondary'},
  ],
};

// `GET /reader/comment/:id` wraps its payload in `item`; the replies endpoint does not.
export const READER_COMMENT_RESPONSE = {
  item: {
    comment: {
      id: 309007328,
      name: 'Thread Root',
      handle: 'root',
      user_id: 1,
      body: 'The root of a thread',
      ancestor_path: '',
      reaction_count: 5,
      children_count: 2,
      attachments: [],
    },
  },
};

export const READER_COMMENT_REPLIES_RESPONSE = {
  rootComment: {id: 309007328, ancestor_path: ''},
  commentBranches: [
    {
      comment: {
        id: 309403526,
        name: 'A Reply',
        handle: 'replier',
        user_id: 2,
        body: 'A reply',
        ancestor_path: '309007328',
        children_count: 1,
        attachments: [],
      },
      descendantComments: [
        {
          id: 309469354,
          name: 'A Nested Reply',
          handle: 'nested',
          user_id: 3,
          body: 'A reply to the reply',
          ancestor_path: '309007328.309403526',
          children_count: 0,
          attachments: [],
        },
      ],
    },
  ],
  moreBranches: false,
  nextCursor: null,
};

// Shaped after `GET substack.com/api/v1/user/profile/self`. Two publications on purpose: the whole
// point of this endpoint is that the session can reach more than the configured one.
export const USER_PROFILE_RESPONSE = {
  id: 41640433,
  name: 'Test User',
  handle: 'testuser',
  bio: 'A test bio',
  photo_url: 'https://example.com/me.png',
  publicationUsers: [
    {role: 'admin', publication: {id: 2150088, subdomain: 'test', name: 'Test Publication'}},
    {role: 'contributor', publication: {id: 2073698, subdomain: 'other', name: 'Other Publication'}},
  ],
  primaryPublication: {id: 2150088, subdomain: 'test'},
  subscriptions: [{id: 1}, {id: 2}, {id: 3}],
};

// Shaped after a real response: the endpoint answers with the page of subscribers plus `count`,
// the total matching the filters regardless of `limit`.
export const SUBSCRIBER_STATS_RESPONSE = {
  count: 2,
  subscribers: [
    {
      user_id: 1,
      user_email_address: 'one@example.com',
      user_name: 'One',
      subscription_type: 'free',
      activity_rating: 3,
      subscription_created_at: '2026-01-01T00:00:00.000000+00:00',
      total_revenue_generated: 0,
    },
    {
      user_id: 2,
      user_email_address: 'two@example.com',
      user_name: 'Two',
      subscription_type: 'paid',
      activity_rating: 5,
      subscription_created_at: '2026-02-01T00:00:00.000000+00:00',
      total_revenue_generated: 50,
    },
  ],
  order: {by: 'subscription_created_at', direction: 'desc'},
  columnView: [{key: 'subscription_type', visible: true}],
  lastSync: '2026-08-07T08:00:00.000Z',
};

export const POSTS_RESPONSE = {
  posts: [
    {id: 10, title: 'Published one', slug: 'published-one', is_published: true, audience: 'everyone'},
    {id: 11, title: 'Published two', slug: 'published-two', is_published: true, audience: 'only_paid'},
  ],
  offset: 0,
  limit: 25,
  total: 861,
  isCapped: false,
};

export const DRAFT_DETAIL_RESPONSE = {
  id: 167712345,
  draft_title: 'A draft',
  draft_subtitle: 'Its subtitle',
  draft_body: '{"type":"doc","content":[]}',
  audience: 'everyone',
  is_published: false,
  slug: 'a-draft',
};

export const DASHBOARD_SUMMARY_RESPONSE = {
  subscribers: 2025,
  subscribersLast30Days: 77,
  totalEmail: 2020,
  arr: 120,
  arrDelta: 10,
  views: 5000,
  viewsDelta: 250,
};

export const OPEN_RATE_RESPONSE = {openRate: 0.42, openRateDiff: 0.01};
export const VIEWS_30D_RESPONSE = {views30d: 5000, viewsDelta30d: 250};

export const PUBLICATION_STATS_URL = `${API}/publication/stats`;
export const EMAIL_STATS_URL = `${API}/publication/stats/email_stats`;

/**
 * Shaped after a real response: `email_stats` is the per-post table, not an aggregate, and `total`
 * is the whole archive rather than the page. Ordered by `signups` descending here, which is what the
 * live API actually returns for that sort.
 */
export const POST_STATS_RESPONSE = {
  total: 863,
  rows: [
    {
      post_id: 163262717,
      title: 'MCP Server for Substack',
      post_date: '2026-05-08T09:00:00.000Z',
      audience: 'everyone',
      type: 'newsletter',
      sent: 1900,
      delivered: 1880,
      opens: 800,
      open_rate: 0.42,
      clicks: 120,
      click_through_rate: 0.06,
      signups: 42,
      subscribes: 6,
      estimated_value: 669.5023091726059,
      unsubscribes: 1,
      views: 3100,
      likes: 30,
      restacks: 4,
      subscribers_finished_post: 610,
      section_name: null,
      tags: [],
      bylines: [{id: 12345}],
    },
    {
      post_id: 163262700,
      title: 'How to Summarize Youtube Video using AI',
      post_date: '2026-04-02T09:00:00.000Z',
      audience: 'everyone',
      type: 'newsletter',
      sent: 1500,
      delivered: 1490,
      opens: 500,
      open_rate: 0.33,
      clicks: 60,
      click_through_rate: 0.04,
      signups: 27,
      subscribes: 2,
      estimated_value: 210.25,
      unsubscribes: 3,
      views: 5195,
      likes: 12,
      restacks: 1,
      subscribers_finished_post: 300,
      section_name: null,
      tags: [],
      bylines: [{id: 12345}],
    },
  ],
};

// One payload for every analytics report: the tool passes the body through untouched, so what it is
// matters far less than which path was asked for and with which parameters.
export const ANALYTICS_RESPONSE = {rows: [{label: 'a', value: 1}], total: 1};

/**
 * Creates the MSW server used by the integration tests.
 *
 * `requests` accumulates every intercepted request: {method, url, headers, body}.
 * `draftsHandler(responder)` builds a handler for POST /drafts that records the request and
 * then delegates the response to `responder`. Use it for overrides passed to `server.use()`
 * as well, otherwise that request never reaches the log.
 */
export function createMswServer() {
  const requests = [];

  async function record(request) {
    const raw = await request.clone().text();

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }

    requests.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    });
  }

  function draftsHandler(responder) {
    return http.post(DRAFTS_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function imageUploadHandler(responder) {
    return http.post(IMAGE_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function subscriberStatsHandler(responder) {
    return http.post(SUBSCRIBER_STATS_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  // One handler for all three statuses: the status is the last path segment, and a test that
  // cares which one was requested reads it off the recorded URL.
  function postsHandler(responder) {
    return http.get(`${POST_MANAGEMENT_URL}/:status`, async ({request, params}) => {
      await record(request);
      return responder(params.status);
    });
  }

  function draftDetailHandler(responder) {
    return http.get(`${DRAFTS_URL}/:id`, async ({request, params}) => {
      await record(request);
      return responder(params.id);
    });
  }

  function draftUpdateHandler(responder) {
    return http.put(`${DRAFTS_URL}/:id`, async ({request, params}) => {
      await record(request);
      return responder(params.id);
    });
  }

  function draftDeleteHandler(responder) {
    return http.delete(`${DRAFTS_URL}/:id`, async ({request, params}) => {
      await record(request);
      return responder(params.id);
    });
  }

  function publishDraftHandler(responder) {
    return http.post(`${DRAFTS_URL}/:id/publish`, async ({request, params}) => {
      await record(request);
      return responder(params.id);
    });
  }

  function publicationHandler(responder) {
    return http.get(PUBLICATION_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function userProfileHandler(responder) {
    return http.get(USER_PROFILE_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function postTagsHandler(responder) {
    return http.get(POST_TAG_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function createPostTagHandler(responder) {
    return http.post(POST_TAG_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function postTagAssociationsHandler(responder) {
    return http.get(`${POST_URL}/:postId/tag`, async ({request, params}) => {
      await record(request);
      return responder(params.postId);
    });
  }

  function addTagToPostHandler(responder) {
    return http.post(`${POST_URL}/:postId/tag/:tagId`, async ({request, params}) => {
      await record(request);
      return responder(params.postId, params.tagId);
    });
  }

  function postCommentsHandler(responder) {
    return http.get(`${POST_URL}/:postId/comments`, async ({request, params}) => {
      await record(request);
      return responder(params.postId);
    });
  }

  function createCommentHandler(responder) {
    return http.post(`${POST_URL}/:postId/comment`, async ({request, params}) => {
      await record(request);
      return responder(params.postId);
    });
  }

  function subscriptionsHandler(responder) {
    return http.get(SUBSCRIPTIONS_URL, async ({request}) => {
      await record(request);
      return responder(new URL(request.url).searchParams.get('cursor'));
    });
  }

  function readerPostsHandler(responder) {
    return http.get(READER_POSTS_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function postByIdHandler(responder) {
    return http.get(`${POST_BY_ID_URL}/:postId`, async ({request, params}) => {
      await record(request);
      return responder(params.postId);
    });
  }

  // Registered before the tabs handler would otherwise shadow it: `/reader/feed/tabs` and
  // `/reader/feed/profile/:id` are both deeper than `/reader/feed`, so each gets its own exact path.
  function readerFeedHandler(responder) {
    return http.get(READER_FEED_URL, async ({request}) => {
      await record(request);
      return responder(new URL(request.url).searchParams.get('tab'));
    });
  }

  function readerFeedTabsHandler(responder) {
    return http.get(READER_FEED_TABS_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function profileFeedHandler(responder) {
    return http.get(`${READER_FEED_URL}/profile/:userId`, async ({request, params}) => {
      await record(request);
      return responder(params.userId);
    });
  }

  function readerCommentHandler(responder) {
    return http.get(`${READER_COMMENT_URL}/:commentId`, async ({request, params}) => {
      await record(request);
      return responder(params.commentId);
    });
  }

  function readerCommentRepliesHandler(responder) {
    return http.get(`${READER_COMMENT_URL}/:commentId/replies`, async ({request, params}) => {
      await record(request);
      return responder(params.commentId);
    });
  }

  function restackHandler(responder) {
    return http.post(RESTACK_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function statsHandler(url, responder) {
    return http.get(url, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function postStatsHandler(responder) {
    return http.get(EMAIL_STATS_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  // A catch-all for the analytics reports: their paths are two and three segments deep, so `*`
  // matches any of them. Registered last so the narrower stats handlers above still win.
  function analyticsHandler(responder) {
    return http.get(`${PUBLICATION_STATS_URL}/*`, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function subscriberSetHandler(responder) {
    return http.post(SUBSCRIBER_SET_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  function exportRequestHandler(responder) {
    return http.post(SUBSCRIBER_SET_EXPORT_URL, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  // Polling: `attempt` counts how many times the status has been asked for, so a test can make the
  // export become ready only on the Nth poll.
  let exportPolls = 0;

  function exportStatusHandler(responder) {
    return http.get(`${SUBSCRIBER_SET_EXPORT_URL}/:exportId`, async ({request, params}) => {
      await record(request);
      exportPolls += 1;
      return responder(params.exportId, exportPolls);
    });
  }

  function exportFileHandler(responder) {
    return http.get(`${SUBSCRIBER_SET_EXPORT_URL}/:exportId/:file`, async ({request}) => {
      await record(request);
      return responder();
    });
  }

  const server = setupServer(
    draftsHandler(() => HttpResponse.json(DRAFT_RESPONSE, {status: 200})),
    imageUploadHandler(() => HttpResponse.json(IMAGE_UPLOAD_RESPONSE, {status: 200})),
    subscriberStatsHandler(() => HttpResponse.json(SUBSCRIBER_STATS_RESPONSE, {status: 200})),
    postsHandler(() => HttpResponse.json(POSTS_RESPONSE, {status: 200})),
    draftDetailHandler(() => HttpResponse.json(DRAFT_DETAIL_RESPONSE, {status: 200})),
    draftUpdateHandler(() => HttpResponse.json(DRAFT_RESPONSE, {status: 200})),
    draftDeleteHandler(() => HttpResponse.json({}, {status: 200})),
    publishDraftHandler(() => HttpResponse.json(PUBLISHED_POST_RESPONSE, {status: 200})),
    publicationHandler(() => HttpResponse.json(PUBLICATION_RESPONSE, {status: 200})),
    userProfileHandler(() => HttpResponse.json(USER_PROFILE_RESPONSE, {status: 200})),
    postTagsHandler(() => HttpResponse.json(POST_TAGS_RESPONSE, {status: 200})),
    createPostTagHandler(() => HttpResponse.json(
      {id: 'aaaaaaaa-0000-0000-0000-000000000000', publication_id: 2150088, name: 'brand new', slug: 'brand-new', hidden: false},
      {status: 200}
    )),
    postTagAssociationsHandler(() => HttpResponse.json(POST_TAG_ASSOCIATIONS_RESPONSE, {status: 200})),
    addTagToPostHandler((postId, tagId) => HttpResponse.json(
      {id: 'ffffffff-0000-0000-0000-000000000000', publication_id: 2150088, post_id: Number(postId), post_tag_id: tagId},
      {status: 200}
    )),
    postCommentsHandler(() => HttpResponse.json(POST_COMMENTS_RESPONSE, {status: 200})),
    createCommentHandler(() => HttpResponse.json(POST_COMMENTS_RESPONSE.comments[0], {status: 200})),
    subscriptionsHandler(() => HttpResponse.json(SUBSCRIPTIONS_RESPONSE, {status: 200})),
    readerPostsHandler(() => HttpResponse.json(READER_POSTS_RESPONSE, {status: 200})),
    postByIdHandler(() => HttpResponse.json(POST_BY_ID_RESPONSE, {status: 200})),
    // The two deeper /reader/feed paths come first: MSW resolves in registration order, and
    // `/reader/feed` registered ahead of them would swallow both.
    readerFeedTabsHandler(() => HttpResponse.json(READER_FEED_TABS_RESPONSE, {status: 200})),
    profileFeedHandler(() => HttpResponse.json(READER_FEED_RESPONSE, {status: 200})),
    readerFeedHandler(() => HttpResponse.json(READER_FEED_RESPONSE, {status: 200})),
    readerCommentRepliesHandler(() => HttpResponse.json(READER_COMMENT_REPLIES_RESPONSE, {status: 200})),
    readerCommentHandler(() => HttpResponse.json(READER_COMMENT_RESPONSE, {status: 200})),
    restackHandler(() => HttpResponse.json({id: 'restack-1'}, {status: 200})),
    statsHandler(DASHBOARD_SUMMARY_URL, () => HttpResponse.json(DASHBOARD_SUMMARY_RESPONSE, {status: 200})),
    statsHandler(OPEN_RATE_URL, () => HttpResponse.json(OPEN_RATE_RESPONSE, {status: 200})),
    statsHandler(VIEWS_30D_URL, () => HttpResponse.json(VIEWS_30D_RESPONSE, {status: 200})),
    postStatsHandler(() => HttpResponse.json(POST_STATS_RESPONSE, {status: 200})),
    subscriberSetHandler(() => HttpResponse.json({id: SUBSCRIBER_SET_ID}, {status: 200})),
    exportRequestHandler(() => HttpResponse.json({export_id: EXPORT_ID}, {status: 200})),
    // Ready on the first poll by default; a test that cares about the wait overrides this.
    exportStatusHandler(() => HttpResponse.json({url: EXPORT_FILE_PATH}, {status: 200})),
    exportFileHandler(() => new HttpResponse(EXPORT_CSV, {
      status: 200,
      headers: {'Content-Type': 'text/csv'},
    })),
    // Last on purpose: MSW resolves in registration order, so the two narrower
    // /publication/stats/... handlers above keep their own payloads and this catches the rest.
    analyticsHandler(() => HttpResponse.json(ANALYTICS_RESPONSE, {status: 200}))
  );

  return {
    server,
    requests,
    draftsHandler,
    imageUploadHandler,
    subscriberStatsHandler,
    postsHandler,
    draftDetailHandler,
    draftUpdateHandler,
    draftDeleteHandler,
    publishDraftHandler,
    publicationHandler,
    userProfileHandler,
    postTagsHandler,
    createPostTagHandler,
    postTagAssociationsHandler,
    addTagToPostHandler,
    postCommentsHandler,
    createCommentHandler,
    subscriptionsHandler,
    readerPostsHandler,
    postByIdHandler,
    readerFeedHandler,
    readerFeedTabsHandler,
    profileFeedHandler,
    readerCommentHandler,
    readerCommentRepliesHandler,
    restackHandler,
    statsHandler,
    postStatsHandler,
    analyticsHandler,
    subscriberSetHandler,
    exportRequestHandler,
    exportStatusHandler,
    exportFileHandler,
    start() {
      server.listen({onUnhandledRequest: 'error'});
    },
    reset() {
      server.resetHandlers();
      requests.length = 0;
      exportPolls = 0;
    },
    stop() {
      server.close();
    },
  };
}
