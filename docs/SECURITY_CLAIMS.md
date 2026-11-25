# Wire Security Claims

Additional security claims beyond the archive security document
(`docs/archive/SECURITY_CLAIMS.md`). Every sentence cites file:line or a test.

## Public domain mode: ipRestrict cannot protect the server

In production, `ALLOWED_SUBNET === '0.0.0.0/0'` (or `'::/0'`) is a fatal
startup error (`config/constants.js:277-287`). A public-facing server
therefore cannot use ipRestrict as an allow-all subnet gate: the production
check refuses it. The effective gate for a publicly reachable server is
JWT authentication (checked on every authenticated request,
`middleware/authenticate.js:62`) plus rate limiting
(`middleware/rateLimiter.js`). `ipRestrict` still applies to clients whose
address falls outside `ALLOWED_SUBNET`, but it cannot be the *sole* gate for
a public domain mode deployment.

## credentialMigration does not bump token_version

`credentialMigration` (legacy auth key → scheme 2 migration,
`services/credentialMigration.service.js`) never touches `users.token_version`
(grep: no match for `token_version` in that file). The token version is only
bumped by password changes (`changeCredentialsV2`,
`services/user.service.js:714`) and by `updatePassword`
(`services/user.service.js:645`). A credential migration therefore does not
revoke existing sessions; the migrated account's existing JWTs remain valid
until a password change or other token_version bump occurs.
