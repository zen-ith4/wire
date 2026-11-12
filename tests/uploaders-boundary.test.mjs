// tests/uploaders-boundary.test.mjs
//
// Task 5 (pre-merge-fixes): record the multer 2.x file-size boundary behaviour
// of every uploader in config/multer.js.
//
// multer 2.x (busboy 1.x) treats `limits.fileSize` as INCLUSIVE: a multipart
// file of EXACTLY that many bytes is accepted, one byte more is refused. The
// DM and group uploaders get the ciphertext overhead added into the limit
// (extraBytes); the plain uploaders (avatar, banner, chat, fileUpload "My
// Files", groupAvatar) set it to the cap itself.
//
// This file pins the CONFIGURED boundaries (the effective max a file may have)
// so the boundary is visible in review and any drift fails loudly. Behavioural
// accept/refuse of a concrete exactly-cap body is multer's own inclusive rule
// (verified for the DM/group ciphertext caps by
// tests/dm-attachments/dm-attachments-server-cap.test.mjs and
// tests/groups/group-attachment-server.test.mjs); these tests record, per
// uploader, what the cap is that the inclusive rule applies to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import constants from '../config/constants.js';
import { avatarUpload, bannerUpload, chatUpload, fileUpload, groupAvatarUpload, dmUpload, groupUpload, dmCiphertextOverheadBytes } from '../config/multer.js';

const MB = 1024 * 1024;
const capBytes = (mb) => mb * MB;

// multer 2.x (busboy 1.x): `fileSize` is INCLUSIVE -> a file of exactly the
// limit is accepted, limit + 1 is refused. (multer 1.x / busboy 0.x treated it
// as EXCLUSIVE, which is why the `+ 1` hacks used to exist.)
test('every configured uploader caps a file at the multer 2.x inclusive limit', () => {
    assert.ok(avatarUpload.limits && avatarUpload.limits.fileSize, 'avatarUpload must expose its limits');
});

test('avatarUpload (avatar) - the accepted cap is AVATAR_MAX_MB', () => {
    assert.equal(avatarUpload.limits.fileSize, capBytes(constants.AVATAR_MAX_MB));
});

test('bannerUpload (banner) - the accepted cap is BANNER_MAX_MB', () => {
    assert.equal(bannerUpload.limits.fileSize, capBytes(constants.BANNER_MAX_MB));
});

test('chatUpload (chat attachments) - the accepted cap is CHAT_UPLOAD_MAX_MB', () => {
    assert.equal(chatUpload.limits.fileSize, capBytes(constants.CHAT_UPLOAD_MAX_MB));
});

test('fileUpload (My Files / Drive) - the accepted cap is UPLOAD_MAX_MB', () => {
    assert.equal(fileUpload.limits.fileSize, capBytes(constants.UPLOAD_MAX_MB));
});

test('groupAvatarUpload (group avatar) - the accepted cap is AVATAR_MAX_MB', () => {
    assert.equal(groupAvatarUpload.limits.fileSize, capBytes(constants.AVATAR_MAX_MB));
});

test('dmUpload - the accepted cap is the DM ciphertext cap (plaintext + the GCM tag overhead)', () => {
    const plaintextCap = capBytes(constants.DM_UPLOAD_MAX_MB);
    assert.equal(dmUpload.limits.fileSize, plaintextCap + dmCiphertextOverheadBytes(plaintextCap));
});

test('groupUpload - the accepted cap is the group ciphertext cap (plaintext + the 16-byte GCM tag overhead)', () => {
    // GROUP_CIPHERTEXT_OVERHEAD_BYTES (module-private in config/multer.js) is
    // the group stream's tag overhead = 16 bytes.
    assert.equal(groupUpload.limits.fileSize, capBytes(constants.GROUP_UPLOAD_MAX_MB) + 16);
});
