import {logger} from "../../logger.js";

// Only the constructor and the methods on the current code path log, all at `debug`. The
// fluent helpers below (`text`, `marks`, `add`, …) run once per chunk of a document and would
// bury every other line at the volume of a real post.
export default class SubstackPost {
  constructor({title = null, subtitle = null, user_id, audience = null, write_comment_permissions = null, subscriber_set_id = null }) {
    this.draft_title = title;
    this.draft_subtitle = subtitle;
    this.draft_body = {type: 'doc', content: []};
    this.draft_bylines = [{id: parseInt(user_id), is_guest: false}];
    this.audience = audience !== null ? audience : 'everyone';
    this.draft_section_id = null;
    this.section_chosen = true;

    if (write_comment_permissions !== null) {
      this.write_comment_permissions = write_comment_permissions;
    } else {
      this.write_comment_permissions = this.audience;
    }

    if (subscriber_set_id !== null) {
      this.subscriber_set_id = subscriber_set_id
      this.type = 'adhoc_email'
    }

    logger.debug('draft.created', {
      draft_title: this.draft_title,
      draft_subtitle: this.draft_subtitle,
      draft_bylines: this.draft_bylines,
      audience: this.audience,
      write_comment_permissions: this.write_comment_permissions,
      type: this.type ?? null,
    });
  }

  setBody(body) {
    logger.debug('draft.setBody', {body});
    this.draft_body = body;
  }

  setTitle(title) {
    logger.debug('draft.setTitle', {title});
    this.draft_title = title;
  }

  setSubtitle(subtitle) {
    logger.debug('draft.setSubtitle', {subtitle});
    this.draft_subtitle = subtitle;
  }

  setSection(name, sections) {
    logger.debug('draft.setSection', {name, sections});

    const section = sections.find(s => s.name === name);

    if (!section) {
      logger.error('draft.setSection.unknown', {name, available: sections.map(s => s.name)});
      throw new Error(`Section ${name} does not exist`);
    }

    this.draft_section_id = section.id;
  }

  add(item) {
    this.draft_body.content = this.draft_body.content || [];
    this.draft_body.content.push({type: item.type});

    const content = item.content;

    if (item.type === 'captionedImage') {
      this.captionedImage(item);
    } else if (item.type === 'youtube2') {
      this.youtube(item.src);
    } else if (item.type === 'subscribeWidget') {
      this.subscribeWithCaption(item.message);
    } else if (item.type === 'bullet_list') {
      this.subscribeWithCaption(item.message);
    } else {
      if (content !== undefined) {
        this.addComplexText(content);
      }
    }

    if (item.type === 'heading') {
      this.attrs(item.level || 1);
    }

    const marks = item.marks;

    if (marks !== undefined) {
      this.marks(marks);
    }

    return this;
  }

  paragraph(content = null) {
    const item = {type: 'paragraph'};

    if (content !== null) {
      item.content = content;
    }

    return this.add(item);
  }

  heading({content = null, level = 1}) {
    const item = {type: 'heading'};

    if (content !== null) {
      item.content = content;
    }

    item.level = level;
    return this.add(item);
  }

  horizontalRule() {
    return this.add({type: 'horizontal_rule'});
  }

  youtubeVideo(resource) {
    const item = {type: 'youtube2'};
    let video_id;
    if (resource.startsWith('http')) {
      const url = new URL(resource);
      // https://www.youtube.com/watch?v=0chZFIZLR_0
      // https://youtu.be/0chZFIZLR_0?si=-Gp9e_RKG3g1SdVG
      video_id = url.searchParams.get('v') || url.pathname.slice(1);
    } else {
      video_id = resource;
    }
    item.src = video_id;
    return this.add(item);
  }

  bulletList(items) {
    this.draft_body.content.push({
      type: 'bullet_list',
      content: items.map(item => {
        const obj = {
          type: 'list_item',
          content: [
            {
              type: 'paragraph',
              content: [{type: 'text', text: item}]
            }
          ]
        }
        return obj
      }),
    });
  }

  orderedList(items) {
    this.draft_body.content.push({
      type: 'ordered_list',
      attrs: {
        start: 1,
        order: 1
      },
      content: items.map(item => {
        const obj = {
          type: 'list_item',
          content: [
            {
              type: 'paragraph',
              content: [{type: 'text', text: item}]
            }
          ]
        }
        return obj
      }),
    });
  }

  italic(text) {
    this.draft_body.content.push({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          marks: [
            {
              type: 'em',
            }
          ],
          text,
        }
      ],
    });
  }

  bold(text) {
    this.draft_body.content.push({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          marks: [
            {
              type: 'strong',
            }
          ],
          text,
        }
      ],
    });
  }

  paywall() {
    this.draft_body.content.push({
      type: 'paywall'
    });
  }

  shareButton() {
    this.draft_body.content.push({
      type: 'button',
      attrs: {
        url: '%%share_url%%',
        text: 'Share',
        action: null,
        class: 'button-wrapper'
      }
    });
  }

  commentButton() {
    this.draft_body.content.push({
      type: 'button',
      attrs: {
        url: '%%half_magic_comments_url%%',
        text: 'Leave a comment',
        action: null,
        class: 'button-wrapper'
      }
    });
  }

  customButton({url, text}) {
    this.draft_body.content.push({
      type: 'button',
      attrs: {
        url,
        text,
        action: null,
        class: 'button-wrapper'
      }
    });
  }

  attrs(level) {
    const contentAttrs = this.draft_body.content[this.draft_body.content.length - 1].attrs || {};
    contentAttrs.level = level;
    this.draft_body.content[this.draft_body.content.length - 1].attrs = contentAttrs;
    return this;
  }

  captionedImage({
                   src,
                   fullscreen = false,
                   imageSize = 'normal',
                   height = 819,
                   width = 1456,
                   resizeWidth = 728,
                   bytes = null,
                   alt = null,
                   title = null,
                   type = null,
                   href = null,
                   belowTheFold = false,
                   internalRedirect = null,
                 }) {
    const content = this.draft_body.content[this.draft_body.content.length - 1].content || [];
    content.push({
      type: 'image2',
      attrs: {
        src,
        fullscreen,
        imageSize,
        height,
        width,
        resizeWidth,
        bytes,
        alt,
        title,
        type,
        href,
        belowTheFold,
        internalRedirect,
      },
    });

    this.draft_body.content[this.draft_body.content.length - 1].content = content;
    return this;
  }

  text(value) {
    const content = this.draft_body.content[this.draft_body.content.length - 1].content || [];
    content.push({type: 'text', text: value});
    this.draft_body.content[this.draft_body.content.length - 1].content = content;
    return this;
  }

  addComplexText(text) {
    if (typeof text === 'string') {
      this.text(text);
    } else {
      text.forEach(chunk => {
        if (chunk) {
          this.text(chunk.content).marks(chunk.marks || []);
        }
      });
    }
  }

  marks(marks) {
    const content = this.draft_body.content[this.draft_body.content.length - 1].content.slice(-1)[0];
    const contentMarks = content.marks || [];

    marks.forEach(mark => {
      const newMark = {type: mark.type};

      if (mark.type === 'link') {
        const href = mark.href;
        newMark.attrs = {href};
      }

      contentMarks.push(newMark);
    });

    content.marks = contentMarks;
    return this;
  }

  removeLastParagraph() {
    this.draft_body.content.pop();
  }

  getDraft() {
    const {draft_body, ...rest} = this;
    const draft = {...rest, draft_body: JSON.stringify(draft_body)};

    logger.debug('draft.getDraft', {draft});
    return draft;
  }

  subscribeWithCaption(message = null) {
    if (message === null) {
      message = `Thanks for reading this newsletter!
      Subscribe for free to receive new posts and support my work.`;
    }

    const subscribe = this.draft_body.content[this.draft_body.content.length - 1];
    subscribe.attrs = {url: '%%checkout_url%%', text: 'Subscribe', language: 'en'};
    subscribe.content = [
      {
        type: 'ctaCaption',
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
      },
    ];

    return this;
  }

  youtube(value) {
    const contentAttrs = this.draft_body.content[this.draft_body.content.length - 1].attrs || {};
    contentAttrs.videoId = value;
    this.draft_body.content[this.draft_body.content.length - 1].attrs = contentAttrs;
    return this;
  }
}
