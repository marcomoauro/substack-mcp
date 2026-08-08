import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {isSubstackHosted} from './image.js';

// The two hosts measured live on 2026-08-08: `POST /api/v1/image` answers a url on the S3 bucket,
// and `list_posts`/`get_draft` hand back covers already rewritten onto the CDN. Both are already
// hosted by Substack, so both must pass through rather than be re-uploaded.
describe('isSubstackHosted', () => {
  test('accepts the S3 bucket POST /api/v1/image returns', () => {
    assert.equal(
      isSubstackHosted('https://substack-post-media.s3.amazonaws.com/public/images/x_1500x1000.jpeg'),
      true
    );
  });

  test('accepts a substackcdn.com url, the form a cover is read back as', () => {
    assert.equal(
      isSubstackHosted('https://substackcdn.com/image/fetch/$s_!0RI6!,f_auto/https%3A%2F%2Fexample.com%2Fa.png'),
      true
    );
  });

  test('rejects an unrelated host', () => {
    assert.equal(isSubstackHosted('https://upload.wikimedia.org/wikipedia/commons/4/47/a.png'), false);
  });

  // The trap a `String.includes` check walks into: an attacker-controlled host that merely contains
  // the string would pass, and the cover would silently point off Substack.
  test('rejects a host that only contains a Substack host as a substring', () => {
    assert.equal(isSubstackHosted('https://substackcdn.com.evil.example/a.png'), false);
    assert.equal(isSubstackHosted('https://notsubstackcdn.com/a.png'), false);
  });

  // Unparseable input must not throw here: the caller decides what to do with it, and a thrown
  // TypeError from the URL parser would surface as a crash rather than a validation message.
  test('returns false for a string that is not a URL', () => {
    assert.equal(isSubstackHosted('not-a-url-at-all'), false);
  });
});
