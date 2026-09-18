const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

const { hashPassword } = require('./password');
const constants = require('../config/constants');

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
            HOST: config.host,
            PORT: config.port
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
        process.env.HOST = config.host;
        process.env.PORT = config.port;
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
        // 1. Ask for IP Address
        // --------------------------------------------------------

        let host = '';

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
        console.log(`Address: ${host}:${port}`);
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
                host,
                port
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