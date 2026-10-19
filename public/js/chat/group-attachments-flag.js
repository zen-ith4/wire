// public/js/chat/group-attachments-flag.js
//
// STEP 3C: the feature flag for group attachments.
//
// It ships as FALSE. With the flag off the group page behaves exactly as
// before: no attach button, no file input, no paste/drop of files, and the
// composer's file paths are inert (the group composer points its file ids at
// elements that do not exist, so composer.js's staging code no-ops).
//
// The test-only setter is gated on a global hook that ONLY a test harness
// sets. server.js never sets it, no page code sets it, and it is not
// reachable from the network, so in production the setter throws and the flag
// can never be flipped from the outside. Flipping the shipped constant is an
// owner decision (STEP 3C says it happens only after the browser tests have
// run on Linux and the result has been reviewed).

export const GROUP_ATTACHMENTS_UI_ENABLED = false;

let enabled = GROUP_ATTACHMENTS_UI_ENABLED;

export function isGroupAttachmentsUiEnabled() {
    return enabled;
}

/**
 * TEST ONLY. Enables/disables the group attachment UI for one test.
 * Throws unless the test harness set the hook global.
 */
export function setGroupAttachmentsUiEnabledForTests(value) {
    if (!globalThis.__WIRE_TEST_HOOK_GROUP_ATTACHMENTS__) {
        throw new Error('group attachment flag: the test-only setter is not available in production');
    }
    enabled = !!value;
}
