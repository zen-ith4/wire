const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

const { hashPassword } = require('./password');
const constants = require('../config/constants');
const envPath = path.join(__dirname, '..', '.env');

class SetupWizard {
    constructor() {
        this.mutableStdout = new Writable({
            write: function (chunk, encoding, callback) {
                if (!this.muted) process.stdout.write(chunk, encoding);
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
                // Safely print the question, then mute the stream for the password
                process.stdout.write(question);
                this.mutableStdout.muted = true;
                this.rl.question('', (answer) => {
                    this.mutableStdout.muted = false;
                    console.log(); // print a newline when Enter is pressed
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
            envContent = fs.readFileSync(envPath, 'utf8');
        }

        // Update SETUP_COMPLETED, HOST, and PORT in the .env file
        const updates = {
            SETUP_COMPLETED: 'true',
            HOST: config.host,
            PORT: config.port
        };

        for (const [key, value] of Object.entries(updates)) {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
                envContent += `\n${key}=${value}`;
            }
        }

        fs.writeFileSync(envPath, envContent.trim() + '\n');
        
        // Apply immediately to the running process
        process.env.SETUP_COMPLETED = 'true';
        process.env.HOST = config.host;
        process.env.PORT = config.port;
    }

    isValidIP(ip) {
        return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
    }

    async run() {
        if (process.env.SETUP_COMPLETED === 'true') {
            return;
        }

        console.log('\n======================================');
        console.log('       Wire First-Run Setup        ');
        console.log('======================================\n');
        
        // --- 1. Ask for IP Address ---
        let host = '';
        while (!this.isValidIP(host)) {
            const defaultHost = process.env.HOST || '10.10.0.7';
            host = await this.ask(`WireGuard IP Address [${defaultHost}]: `);
            host = host || defaultHost;
            if (!this.isValidIP(host)) {
                console.log('Error: Invalid IPv4 address.\n');
            }
        }

        // --- 2. Ask for Port ---
        let port = '';
        while (true) {
            const defaultPort = process.env.PORT || '3000';
            port = await this.ask(`Port [${defaultPort}]: `);
            port = port || defaultPort;
            if (isNaN(port) || port < 1 || port > 65535) {
                console.log('Error: Invalid port number.\n');
                continue;
            }
            break;
        }
        
        console.log(); // Blank line for spacing

        // --- 3. Ask for Admin Credentials ---
        let username = '';
        while (!username) {
            username = await this.ask('Admin username: ');
            if (username.length < 3) {
                console.log('Error: Username must be at least 3 characters.');
                username = '';
            }
        }

        let password = '';
        while (true) {
            password = await this.ask('Admin password: ', true);
            const confirmPassword = await this.ask('Confirm admin password: ', true);

            if (password.length < 6) {
                console.log('Error: Password must be at least 6 characters.\n');
                continue;
            }

            if (password !== confirmPassword) {
                console.log('Error: Passwords do not match. Try again.\n');
                continue;
            }
            break;
        }

        console.log('\n--- Configuration Summary ---');
        console.log(`Address: ${host}:${port}`);
        console.log(`Admin Username: ${username}`);
        
        const confirm = await this.ask('\nApply configuration and continue? [y/N]: ');
        if (confirm.toLowerCase() !== 'y') {
            console.log('Setup aborted. Restart the server to try again.');
            process.exit(0);
        }

        let db;
        try {
            // Hash password and save to DB
            const hashedPassword = hashPassword(password);
            password = null;

            const Database = require('better-sqlite3');
            const dbPath = process.env.DB_PATH || constants.DB_PATH || './data.db';
            db = new Database(dbPath);

            const stmt = db.prepare(`
                INSERT INTO users (
                  username,
                  password_hash,
                  is_admin
                )
                VALUES (?, ?, 1)
            `);
            
            stmt.run(username, hashedPassword);
            db.close();

            // Update environment variables
            this.updateEnvFile({ host, port });

            console.log('\n Wire setup completed successfully.');
            console.log('Server is ready.\n');
            
        } catch (error) {
            console.error('\nFatal error during setup:', error);
            if (db) db.close();
            process.exit(1);
        } finally {
            this.rl.close();
        }
    }
}

module.exports = async function runSetupWizard() {
    // The normal case on every restart after the very first run:
    // setup is already done and there's nothing for the wizard to
    // do. Checking this *before* constructing SetupWizard matters —
    // its constructor unconditionally opens a readline.Interface on
    // process.stdin (terminal:true), which puts stdin into raw
    // listening mode and keeps the event loop alive for as long as
    // it stays open. run() itself already handled the
    // already-completed case correctly by returning immediately,
    // but that left the readline interface it had just opened
    // sitting there unclosed for the rest of the server's lifetime
    // — a real resource, alive with nothing left to do, on every
    // single restart. Skipping construction entirely when it isn't
    // needed is a strict improvement over closing it right after
    // opening it: same end state (no wizard resources held), zero
    // wasted readline setup on the hot path (every normal restart).
    if (process.env.SETUP_COMPLETED === 'true') {
        return;
    }

    const wizard = new SetupWizard();
    await wizard.run();
};