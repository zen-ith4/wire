const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

const { hashPassword } = require('./password');
const constants = require('../config/constants');
const tlsSetup = require('./tlsSetup');

const {
    createAndSendVerificationCode,
    verifyEmailCode
} = require('../services/emailVerification.service');

const {
    isEmailEnabled
} = require('../services/email.service');

const envPath = path.join(__dirname, '..', '.env');

class SetupWizard {
    constructor() {
        this.mutableStdout = new Writable({
            write: function (chunk, encoding, callback) {
                if (!this.muted) {
                    process.stdout.write(chunk, encoding);
                }

                callback();
            }
        });

        this.rl = readline.createInterface({
            input: process.stdin,
            output: this.mutableStdout,
            terminal: true
        });
    }

    async ask(question, hidden = false) {
        return new Promise((resolve) => {
            if (hidden) {
                process.stdout.write(question);

                this.mutableStdout.muted = true;

                this.rl.question('', (answer) => {
                    this.mutableStdout.muted = false;

                    console.log();

                    resolve(answer.trim());
                });
            } else {
                this.rl.question(question, (answer) => {
                    resolve(answer.trim());
                });
            }
        });
    }

    updateEnvFile(config) {
        let envContent = '';

        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(
                envPath,
                'utf8'
            );
        }

        const updates = {
            SETUP_COMPLETED: 'true',
            HOST: config.expressHost,
            PUBLIC_HOST: config.publicHost,
            PORT: config.port,
            HTTPS_MODE: config.httpsMode,
            DOMAIN: config.domain || '',
            TLS_CERT_FINGERPRINT: config.tlsFingerprint || ''
        };

        for (const [key, value] of Object.entries(updates)) {
            const regex = new RegExp(
                `^${key}=.*$`,
                'm'
            );

            if (regex.test(envContent)) {
                envContent = envContent.replace(
                    regex,
                    `${key}=${value}`
                );
            } else {
                envContent += `\n${key}=${value}`;
            }
        }

        fs.writeFileSync(
            envPath,
            envContent.trim() + '\n'
        );

        // Apply immediately to the running process
        process.env.SETUP_COMPLETED = 'true';
        process.env.HOST = config.expressHost;
        process.env.PUBLIC_HOST = config.publicHost;
        process.env.PORT = config.port;
        process.env.HTTPS_MODE = updates.HTTPS_MODE;
        process.env.DOMAIN = updates.DOMAIN;
        process.env.TLS_CERT_FINGERPRINT = updates.TLS_CERT_FINGERPRINT;
    }

    isValidIP(ip) {
        return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
    }

    isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    /**
     * Ask for the verification code and verify it using
     * the same email verification service used by normal users.
     */
    async verifyAdminEmail(user) {
        console.log('\n--------------------------------------');
        console.log('        Email Verification');
        console.log('--------------------------------------\n');

        console.log(
            `A verification code has been sent to ${user.email}.`
        );

        console.log(
            'The code is valid for 10 minutes.'
        );

        console.log(
            'You have up to 5 attempts.\n'
        );

        while (true) {
            const code = await this.ask(
                'Verification code: '
            );

            if (!/^\d{6}$/.test(code)) {
                console.log(
                    'Error: Verification code must be exactly 6 digits.\n'
                );

                continue;
            }

            const result = await verifyEmailCode(
                user.id,
                code
            );

            if (result.success) {
                console.log(
                    '\nEmail verified successfully.\n'
                );

                return true;
            }

            switch (result.reason) {
                case 'EXPIRED':
                    console.log(
                        '\nError: Verification code expired.'
                    );

                    return false;

                case 'TOO_MANY_ATTEMPTS':
                    console.log(
                        '\nError: Too many verification attempts.'
                    );

                    return false;

                case 'INVALID_CODE':
                default:
                    console.log(
                        'Error: Invalid verification code.\n'
                    );

                    break;
            }
        }
    }

    async run() {
        if (process.env.SETUP_COMPLETED === 'true') {
            return;
        }

        console.log('\n======================================');
        console.log('       Wire First-Run Setup');
        console.log('======================================\n');

        // --------------------------------------------------------
        // 1. How will people reach this server?
        // --------------------------------------------------------
        //
        // Asked first because it decides everything downstream: what
        // we even ask next (a domain vs. a WireGuard IP), whether we
        // touch TLS at all, and - importantly - what address Express
        // itself binds to. When Caddy is fronting the app (either
        // mode below), Express must listen on 127.0.0.1 only, since
        // that's what Caddy's reverse_proxy in the generated
        // Caddyfile connects to; Caddy is the one holding the
        // public-facing IP/domain and the TLS certificate. Express
        // binding to the WireGuard IP directly was last setup's bug -
        // Caddy couldn't reach it. Fixed by keeping that distinction
        // explicit here as `host` (what the *outside world* uses) vs.
        // `expressHost` (what Express itself binds to).

        console.log('--- How will people reach this server? ---\n');
        console.log(
            '  1) I have a domain name and can get real SSL for it'
        );
        console.log(
            '     (automatic HTTPS via Caddy + Let\'s Encrypt - no manual cert handling)'
        );
        console.log(
            '  2) Just WireGuard - no domain'
        );
        console.log(
            '     (private network only; a WireGuard IP like 10.10.0.7)\n'
        );

        let reachMode = '';

        while (!['1', '2'].includes(reachMode)) {
            reachMode = await this.ask(
                'Choice [1/2]: '
            );
        }

        console.log();

        let host = '';        // what the outside world types/connects to
        let expressHost = ''; // what Express itself binds to
        let domain = null;
        let httpsMode = '';   // 'domain' | 'self-signed' | 'none' - stored in .env
        let tlsFingerprint = null;

        if (reachMode === '1') {

            // ----------------------------------------------------
            // 1a. Domain
            // ----------------------------------------------------

            while (!domain) {
                domain = await this.ask(
                    'Domain (e.g. chat.example.com): '
                );

                domain = domain.trim().toLowerCase();

                if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
                    console.log(
                        'Error: That doesn\'t look like a valid domain.\n'
                    );

                    domain = '';
                }
            }

            host = domain;
            expressHost = '127.0.0.1'; // Caddy fronts on 443, proxies here
            httpsMode = 'domain';

        } else {

            // ----------------------------------------------------
            // 1b. WireGuard IP
            // ----------------------------------------------------

            while (!this.isValidIP(host)) {
                const defaultHost =
                    process.env.HOST || '10.10.0.7';

                host = await this.ask(
                    `WireGuard IP Address [${defaultHost}]: `
                );

                host = host || defaultHost;

                if (!this.isValidIP(host)) {
                    console.log(
                        'Error: Invalid IPv4 address.\n'
                    );
                }
            }
        }

        // --------------------------------------------------------
        // 2. Ask for Port
        // --------------------------------------------------------

        let port = '';

        while (true) {
            const defaultPort =
                process.env.PORT || '3000';

            port = await this.ask(
                `Port [${defaultPort}]: `
            );

            port = port || defaultPort;

            const numericPort = Number(port);

            if (
                !Number.isInteger(numericPort) ||
                numericPort < 1 ||
                numericPort > 65535
            ) {
                console.log(
                    'Error: Invalid port number.\n'
                );

                continue;
            }

            port = String(numericPort);

            break;
        }

        console.log();

        // --------------------------------------------------------
        // 2.5. HTTPS for WireGuard-only deployments
        // --------------------------------------------------------
        //
        // Domain mode (1a above) always gets HTTPS via Caddy/Let's
        // Encrypt - there's no reason to ever skip it. WireGuard-only
        // deployments have no CA that will issue a cert for a private
        // IP, so this is the one place a self-signed cert - or
        // skipping HTTPS entirely - is actually a choice.
        //
        // Web Crypto (crypto.subtle - what E2EE and the voice
        // features depend on) only works in a "secure context":
        // https://, or http://localhost / http://127.0.0.1. A plain
        // WireGuard IP like 10.10.0.7 over http:// does NOT qualify -
        // crypto.subtle is simply undefined there, in every browser
        // and in this project's own Electron client (no webSecurity
        // bypass is configured).

        if (reachMode === '2') {

            console.log('--- HTTPS ---\n');
            console.log(
                'Enable HTTPS with a self-signed certificate for'
            );
            console.log(
                `${host}? Needed for E2EE and voice to work for anyone`
            );
            console.log(
                'other than localhost connections. (Recommended.)\n'
            );

            const enableHttps = await this.ask(
                'Enable HTTPS? [Y/n]: '
            );

            if (enableHttps.trim().toLowerCase() !== 'n') {

                console.log(
                    `\nGenerating a self-signed certificate for ${host} ...`
                );

                const tlsResult =
                    await tlsSetup.generateSelfSignedCert(host);

                tlsSetup.writeCaddyfileForSelfSigned(
                    host,
                    port,
                    tlsResult.certPath,
                    tlsResult.keyPath
                );

                tlsFingerprint = tlsResult.fingerprint;
                httpsMode = 'self-signed';
                expressHost = '127.0.0.1'; // Caddy fronts on the WireGuard IP, proxies here

                console.log(
                    '\nCertificate generated. SHA-256 fingerprint:\n'
                );

                console.log(`  ${tlsFingerprint}\n`);

                console.log(
                    'Give this fingerprint to anyone connecting with the'
                );

                console.log(
                    'Electron client - it lets them verify the server on'
                );

                console.log(
                    'first connect without installing anything (see GUIDE.md).'
                );

                console.log(
                    'Browser users just click through the one-time "not private"'
                );

                console.log(
                    'warning - that alone is enough for crypto.subtle to work.\n'
                );

            } else {

                httpsMode = 'none';
                expressHost = host; // no Caddy - Express is reached directly

                console.log(
                    '\nSkipped. Remember: E2EE and voice will not work over'
                );

                console.log(
                    'plain HTTP for anyone except localhost connections.\n'
                );
            }

        } else {

            console.log(
                `Wrote Caddyfile for automatic HTTPS on ${domain}.`
            );

            console.log(
                'Caddy will request and renew the certificate itself - nothing else to do.\n'
            );

            tlsSetup.writeCaddyfileForDomain(domain, port);
        }

        // --------------------------------------------------------
        // 3. Ask for Admin Username
        // --------------------------------------------------------

        let username = '';

        while (!username) {
            username = await this.ask(
                'Admin username: '
            );

            username = username
                .trim()
                .toLowerCase();

            if (username.length < 3) {
                console.log(
                    'Error: Username must be at least 3 characters.'
                );

                username = '';
            }
        }

        // --------------------------------------------------------
        // 4. Ask for Admin Email
        // --------------------------------------------------------

        let email = '';

        while (!email) {
            email = await this.ask(
                'Admin email: '
            );

            email = email
                .trim()
                .toLowerCase();

            if (!this.isValidEmail(email)) {
                console.log(
                    'Error: Invalid email address.\n'
                );

                email = '';
            }
        }

        // --------------------------------------------------------
        // 5. Ask for Admin Password
        // --------------------------------------------------------

        let password = '';

        while (true) {
            password = await this.ask(
                'Admin password: ',
                true
            );

            const confirmPassword =
                await this.ask(
                    'Confirm admin password: ',
                    true
                );

            if (password.length < 6) {
                console.log(
                    'Error: Password must be at least 6 characters.\n'
                );

                continue;
            }

            if (password !== confirmPassword) {
                console.log(
                    'Error: Passwords do not match. Try again.\n'
                );

                continue;
            }

            break;
        }

        // --------------------------------------------------------
        // 6. Configuration Summary
        // --------------------------------------------------------

        const emailEnabled = isEmailEnabled();

        console.log('\n--- Configuration Summary ---');
        console.log(`Public address: ${host}:${httpsMode === 'none' ? port : 443}`);

        console.log(
            `HTTPS: ${
                httpsMode === 'domain'
                    ? `domain (${domain}, Let's Encrypt via Caddy)`
                    : httpsMode === 'self-signed'
                        ? 'self-signed (fingerprint above, via Caddy)'
                        : 'none (plain HTTP)'
            }`
        );

        if (httpsMode !== 'none') {
            console.log(
                `Express itself listens on: ${expressHost}:${port} (Caddy fronts it - see Caddyfile)`
            );
        }

        console.log(`Admin Username: ${username}`);
        console.log(`Admin Email: ${email}`);

        console.log(
            `Email Verification: ${
                emailEnabled ? 'Enabled' : 'Disabled'
            }`
        );

        const confirm = await this.ask(
            '\nApply configuration and continue? [y/N]: '
        );

        if (confirm.toLowerCase() !== 'y') {
            console.log(
                'Setup aborted. Restart the server to try again.'
            );

            process.exit(0);
        }

        let db;

        try {
            // ----------------------------------------------------
            // 7. Hash Admin Password
            // ----------------------------------------------------

            const hashedPassword =
                await hashPassword(password);

            // Remove plaintext password reference
            password = null;

            // ----------------------------------------------------
            // 8. Open Database
            // ----------------------------------------------------

            const Database =
                require('better-sqlite3');

            const dbPath =
                process.env.DB_PATH ||
                constants.DB_PATH ||
                './data.db';

            db = new Database(dbPath);

            // ----------------------------------------------------
            // 9. Create Admin User
            // ----------------------------------------------------

            // If email verification is enabled, the account
            // starts unverified and must complete the OTP step.
            //
            // If email verification is disabled, the admin is
            // immediately considered verified.
            const emailVerified =
                emailEnabled ? 0 : 1;

            const stmt = db.prepare(`
                INSERT INTO users (
                    username,
                    email,
                    password_hash,
                    email_verified,
                    is_admin
                )
                VALUES (?, ?, ?, ?, 1)
            `);

            const result = stmt.run(
                username,
                email,
                hashedPassword,
                emailVerified
            );

            const userId =
                Number(result.lastInsertRowid);

            // ----------------------------------------------------
            // 10. Read Created Admin
            // ----------------------------------------------------

            const user = db.prepare(`
                SELECT
                    id,
                    username,
                    email,
                    email_verified,
                    is_admin,
                    is_active
                FROM users
                WHERE id = ?
            `).get(userId);

            if (!user) {
                throw new Error(
                    'Failed to retrieve newly created admin user'
                );
            }

            // ----------------------------------------------------
            // 11. Email Verification
            // ----------------------------------------------------

            if (emailEnabled) {
                // Send OTP
                try {
                    await createAndSendVerificationCode(user);
                } catch (error) {
                    // Do not leave an unusable unverified admin
                    // account behind if email delivery fails.
                    db.prepare(`
                        DELETE FROM users
                        WHERE id = ?
                    `).run(userId);

                    throw error;
                }

                // Ask for the OTP directly inside the setup wizard.
                const verified =
                    await this.verifyAdminEmail(user);

                if (!verified) {
                    console.log(
                        '\nAdmin email verification failed.'
                    );

                    console.log(
                        'Setup was not completed.'
                    );

                    // Remove the incomplete admin account.
                    db.prepare(`
                        DELETE FROM users
                        WHERE id = ?
                    `).run(userId);

                    // Remove the verification record too.
                    db.prepare(`
                        DELETE FROM email_verification_codes
                        WHERE user_id = ?
                    `).run(userId);

                    db.close();
                    db = null;

                    process.exit(1);
                }
            }

            // ----------------------------------------------------
            // 12. Close Database
            // ----------------------------------------------------

            db.close();
            db = null;

            // ----------------------------------------------------
            // 13. Mark Setup as Completed
            // ----------------------------------------------------

            // IMPORTANT:
            // This happens only after successful verification.
            this.updateEnvFile({
                expressHost,
                publicHost: host,
                port,
                httpsMode,
                domain,
                tlsFingerprint
            });

            console.log(
                'Wire setup completed successfully.'
            );

            console.log(
                'Server is ready.\n'
            );

        } catch (error) {
            console.error(
                '\nFatal error during setup:',
                error
            );

            if (db) {
                try {
                    db.close();
                } catch {
                    // Ignore database close errors
                }
            }

            process.exit(1);

        } finally {
            this.rl.close();
        }
    }
}

module.exports = async function runSetupWizard() {
    // Normal case on every restart after the first setup.
    // Do not construct readline when the wizard is not needed.
    if (process.env.SETUP_COMPLETED === 'true') {
        return;
    }

    const wizard = new SetupWizard();

    await wizard.run();
};