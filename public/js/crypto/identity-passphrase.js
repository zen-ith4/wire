const MODAL_ID = "identity-passphrase-modal";

function getModal() {
    return document.getElementById(MODAL_ID);
}

function removeModal() {
    const modal = getModal();

    if (modal) {
        modal.remove();
    }
}

function createModal({
    title,
    description,
    confirmText
}) {
    removeModal();

    const modal = document.createElement("div");

    modal.id = MODAL_ID;
    modal.className = "identity-passphrase-modal";

    modal.innerHTML = `
        <div class="identity-passphrase-backdrop"></div>

        <div
            class="identity-passphrase-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="identity-passphrase-title"
        >
            <h2 id="identity-passphrase-title">
                ${title}
            </h2>

            <p class="identity-passphrase-description">
                ${description}
            </p>

            <form class="identity-passphrase-form">
                <label for="identity-passphrase-input">
                    Identity Passphrase
                </label>

                <input
                    id="identity-passphrase-input"
                    class="identity-passphrase-input"
                    type="password"
                    autocomplete="off"
                    spellcheck="false"
                    required
                />

                <div class="identity-passphrase-error"></div>

                <div class="identity-passphrase-actions">
                    <button
                        type="submit"
                        class="identity-passphrase-submit"
                    >
                        ${confirmText}
                    </button>
                </div>
            </form>
        </div>
    `;

    document.body.appendChild(modal);

    return modal;
}


/* =========================================================
 * Create new identity
 * ========================================================= */

export function requestNewIdentityPassphrase() {
    return new Promise((resolve, reject) => {
        const modal = createModal({
            title: "Create Identity Passphrase",
            description:
                "This passphrase protects your encrypted identity key. It is never sent to the server.",
            confirmText: "Create Identity"
        });

        const form =
            modal.querySelector(
                ".identity-passphrase-form"
            );

        const input =
            modal.querySelector(
                "#identity-passphrase-input"
            );

        const error =
            modal.querySelector(
                ".identity-passphrase-error"
            );

        input.focus();

        function cleanup() {
            form.removeEventListener(
                "submit",
                handleSubmit
            );

            removeModal();
        }

        function handleSubmit(event) {
            event.preventDefault();

            const passphrase =
                input.value;

            if (!passphrase) {
                error.textContent =
                    "Passphrase is required.";

                input.focus();

                return;
            }

            cleanup();

            resolve(passphrase);
        }

        form.addEventListener(
            "submit",
            handleSubmit
        );
    });
}


/* =========================================================
 * Restore existing identity
 * ========================================================= */

export function requestIdentityPassphrase() {
    return new Promise((resolve, reject) => {
        const modal = createModal({
            title: "Unlock Identity",
            description:
                "Enter your Identity Passphrase to unlock your encrypted identity key.",
            confirmText: "Unlock"
        });

        const form =
            modal.querySelector(
                ".identity-passphrase-form"
            );

        const input =
            modal.querySelector(
                "#identity-passphrase-input"
            );

        const error =
            modal.querySelector(
                ".identity-passphrase-error"
            );

        input.focus();

        function cleanup() {
            form.removeEventListener(
                "submit",
                handleSubmit
            );

            removeModal();
        }

        function handleSubmit(event) {
            event.preventDefault();

            const passphrase =
                input.value;

            if (!passphrase) {
                error.textContent =
                    "Passphrase is required.";

                input.focus();

                return;
            }

            cleanup();

            resolve(passphrase);
        }

        form.addEventListener(
            "submit",
            handleSubmit
        );
    });
}