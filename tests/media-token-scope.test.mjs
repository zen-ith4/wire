import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const js = (rel) => new URL(`../public/js/${rel}`, import.meta.url).href;
const calls = [];
mock.module(js('core/api.js'), {
  namedExports: {
    api: async (url) => {
      calls.push(url);
      return { token: 'scope-token' };
    },
  },
});
mock.module(js('media/attachment-e2ee.js'), {
  namedExports: {
    getAttachmentSecret: () => null,
    fetchDecryptedAttachment: async () => { throw new Error('unexpected decrypt'); },
  },
});
const { getMediaToken, resolveMediaSrc, clearMediaTokenCache } = await import(js('media/mediaToken.js'));

test('dm scope keeps the established token URL and returns its token', async () => {
  clearMediaTokenCache();
  calls.length = 0;
  assert.equal((await getMediaToken('dm', 7)).token, 'scope-token');
  assert.deepEqual(calls, ['/api/dm/attachments/7/media-token']);
});

test('unsupported scopes reject with their scope named and never call api', async () => {
  for (const scope of ['group', 'chat', undefined, '', 'DM']) {
    clearMediaTokenCache();
    calls.length = 0;
    await assert.rejects(getMediaToken(scope, 7), (error) => {
      assert.match(error.message, new RegExp(String(scope)));
      if (scope === 'group') {
        assert.match(error.message, /group media is not served through mediaToken/i);
        assert.match(error.message, /pre-resolved \{ src, isBlob \}/);
      }
      return true;
    });
    assert.deepEqual(calls, [], `api must not be called for ${String(scope)}`);
  }
});

test('resolveMediaSrc rejects an unsupported group scope with the same guidance', async () => {
  clearMediaTokenCache();
  calls.length = 0;
  await assert.rejects(resolveMediaSrc({ id: 7 }, 'group'), (error) => {
    assert.match(error.message, /group/);
    assert.match(error.message, /group media is not served through mediaToken/i);
    assert.match(error.message, /pre-resolved \{ src, isBlob \}/);
    return true;
  });
  assert.deepEqual(calls, []);
});
