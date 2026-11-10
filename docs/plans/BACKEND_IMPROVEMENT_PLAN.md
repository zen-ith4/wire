# Backend Improvement Plan

> **Audit note (2026-11-09).** Each numbered item below now has a one-line status taken from the code. The plan itself is unchanged.

This document lists the most valuable improvements for making the Wire backend more secure, reliable, maintainable, and production-ready.

## Priority 1: Production Security

### 1. Use production-safe environment configuration

> **Status checked against the tree (2026-11-09):** Environment: the server refuses the `CHANGE_ME` example secret (`config/constants.js`); `.env` handling is operational, not code. **Partly done.**

- Set `NODE_ENV=production` in production.
- Set `SETUP_COMPLETED=true` after the initial setup.
- Restrict `ALLOWED_SUBNET` to the actual WireGuard subnet instead of `0.0.0.0/0`.
- Use a strong, randomly generated `JWT_SECRET` and keep it outside the repository.
- Keep SMTP credentials and all other secrets outside source control.
- Run the service under a dedicated, non-administrator operating-system account.

### 2. Add security headers

> **Status checked against the tree (2026-11-09):** `middleware/csp.js` sends a strict CSP including `frame-ancestors 'none'`; `X-Content-Type-Options: nosniff` is set on file/media responses only. No global helmet-style set; HSTS, Referrer-Policy and Permissions-Policy are not set by the app (the generated Caddyfile in `utils/tlsSetup.js` is not covered here). **Partly done.**

Add a security middleware such as Helmet, or configure equivalent headers manually:

- `Content-Security-Policy`
- `Strict-Transport-Security` when HTTPS is enabled
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options` or `frame-ancestors`
- `Referrer-Policy`
- `Permissions-Policy`

### 3. Enforce HTTPS or a secure reverse proxy

> **Status checked against the tree (2026-11-09):** `app.set('trust proxy', ...)` is derived from `HOST` (`middleware/ipRestrict.js`); the setup wizard can generate a TLS setup (`utils/tlsSetup.js`). **Done / partly done.**

Use HTTPS for every non-local deployment. If TLS is terminated by a reverse proxy, configure proxy trust carefully and only for known proxy addresses.

### 4. Add session revocation

> **Status checked against the tree (2026-11-09):** **Done:** per-user `token_version` (`database/migrations.js`), carried as `tv`, checked in `middleware/authenticate.js`, `middleware/mediaAuth.js` and `config/socket.js`; deactivated users are refused (`is_active`).

The current JWT design allows a token to remain valid until expiration. Add one of the following:

- A per-user `token_version` stored in the database and included in the JWT.
- A server-side session table with revocation and device tracking.
- A global key rotation mechanism for emergency invalidation.

This is especially important after password changes, account deactivation, or suspected compromise.

## Priority 2: File and Storage Protection

### 5. Add storage quotas

> **Status checked against the tree (2026-11-09):** No quota code found. **Open.**

The current upload limits protect individual requests, but not total disk usage. Add:

- Per-user storage quotas.
- Per-folder quotas where appropriate.
- Maximum file-count limits.
- A scheduled cleanup process for abandoned temporary files.
- Monitoring and alerts when disk usage is high.

### 6. Harden filesystem boundaries

> **Status checked against the tree (2026-11-09):** `utils/safePath.js`, `utils/folderPolicy.js`, `realpath` use in `controllers/files.controller.js`, `ALLOWED_FOLDER_ROOTS`. **Largely done**; "regular files only" and "no absolute paths in responses" were not individually checked.

- Resolve and validate real paths to protect against symlink-based escapes.
- Restrict administrator-managed folders to an explicit allowlisted root when possible.
- Verify that download and preview targets are regular files.
- Avoid exposing absolute filesystem paths in API responses.

### 7. Improve upload processing

> **Status checked against the tree (2026-11-09):** Content-based type detection exists (`utils/detectFileType.js`, `file-type`). No malware scanning, no isolated thumbnail worker found. **Partly done.**

- Detect file types from file contents, not only extensions.
- Consider antivirus or malware scanning for untrusted uploads.
- Generate thumbnails and previews in an isolated worker process.
- Avoid processing very large files synchronously in request handlers.

## Priority 3: Reliability and Scalability

### 8. Add graceful shutdown

> **Status checked against the tree (2026-11-09):** No `SIGTERM`/`SIGINT` handler found in the app code. **Open.**

Handle `SIGTERM` and `SIGINT` to:

- Stop accepting new requests.
- Close Socket.IO connections.
- Close the SQLite database.
- Finish or cancel active uploads safely.
- Exit only after resources are released.

### 9. Improve rate limiting for multiple instances

> **Status checked against the tree (2026-11-09):** Rate limiters keep state in process memory (`Map`s in `middleware/rateLimiter.js`). **Open.**

The current rate limiters use process memory. Use Redis or another shared store when running more than one backend instance.

### 10. Move expensive work to background jobs

> **Status checked against the tree (2026-11-09):** No job queue found. **Open.**

Email delivery, media processing, virus scanning, and large filesystem operations should use a job queue instead of blocking normal API requests.

### 11. Plan the database growth path

> **Status checked against the tree (2026-11-09):** Design note, no code expected. SQLite still in use.

SQLite is a good fit for a private single-node deployment. If concurrent users, message volume, or multiple backend instances grow substantially, evaluate PostgreSQL and a migration strategy early.

## Priority 4: Testing and Quality

### 12. Add automated tests

> **Status checked against the tree (2026-11-09):** **Done, extensively:** 159 test files under `tests/` (see `docs/archive/REFERENCE.md`).

Create unit and integration tests for:

- Login, registration, email verification, and 2FA.
- JWT validation and token expiration.
- Deactivated-user access.
- Folder ownership and shared-folder permissions.
- Path traversal and symlink escape attempts.
- Upload type validation and preview behavior.
- Chat and direct-message authorization.
- Rate-limit behavior.

Use a temporary test database and isolated temporary directories for filesystem tests.

### 13. Add API contract tests

> **Status checked against the tree (2026-11-09):** No OpenAPI/Swagger files found. **Open.**

Document the API with OpenAPI and validate request and response shapes automatically. This will make frontend/backend changes safer.

### 14. Add continuous integration

> **Status checked against the tree (2026-11-09):** No `.github/` in the repository; `docs/ci/linux-tests.yml` is a template for the browser tests only. **Open.**

Every pull request should run:

1. Dependency audit.
2. Syntax and lint checks.
3. Unit tests.
4. Integration tests.
5. A production-style startup check.

## Priority 5: Maintainability and Operations

### 15. Improve logging

> **Status checked against the tree (2026-11-09):** No request-id/correlation-id code found. **Open.**

Use structured logs with:

- Request ID or correlation ID.
- User ID where available.
- HTTP method and route.
- Status code and duration.
- Error category.

Never log passwords, JWTs, OTP codes, or SMTP credentials.

### 16. Add monitoring

> **Status checked against the tree (2026-11-09):** No `/health` route found. **Open.**

Track:

- Request latency and error rates.
- Login failures and rate-limit events.
- Upload failures.
- Database lock errors.
- Disk usage.
- Active Socket.IO connections.
- Memory and CPU usage.

Add a protected health endpoint that checks the database and required storage directories.

### 17. Improve dependency management

> **Status checked against the tree (2026-11-09):** `package-lock.json` is committed. Both `bcrypt` (`utils/password.js`) and `bcryptjs` (`database/seed.js`) are used; no audit step in CI. **Partly done.**

- Keep `package-lock.json` committed to the repository.
- Run dependency audits in CI.
- Review breaking upgrades separately from routine security updates.
- Remove unused dependencies regularly.

### 18. Add consistent validation

> **Status checked against the tree (2026-11-09):** No schema-validation library in `package.json`. **Open.**

Use a shared schema-validation library for request bodies, query parameters, and route parameters. This reduces duplicated validation logic and makes API behavior more predictable.

## Suggested Implementation Order

1. Production environment validation and secret management.
2. Automated security and permission tests.
3. Storage quotas and filesystem boundary hardening.
4. Graceful shutdown and structured logging.
5. Health checks and monitoring.
6. OpenAPI documentation and CI.
7. Background jobs and multi-instance support.
8. Database migration planning if usage grows.

## Target Outcome

After completing the first five priorities, the backend should be suitable for a controlled production deployment on a private WireGuard network. The remaining items will improve scale, observability, and long-term maintainability.
