# Windows notes (local)

`readHandoffSecret` / `ensureHandoffDir` (password and cookie one-shot secret files) are **disabled on win32** and fail closed with:

> password handoff via secret file is unsupported on Windows; POSIX ownership/mode checks cannot be enforced

The handoff relies on POSIX uid ownership and 0700/0600 modes, which Node cannot report or enforce on Windows (lstat yields uid 0, mode 0666). An icacls owner-only ACL check was not implemented because it cannot be done race-free against the pinned descriptor. Use stdin (`--password-file -`) or env-based sources on Windows. Lexical path-shape checks (absolute, direct child, no traversal) still run before the refusal.
