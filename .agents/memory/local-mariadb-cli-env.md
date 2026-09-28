---
name: Local MariaDB CLI environment precedence
description: How dev MySQL environment variables can override socket CLI flags in this workspace.
---

The local MariaDB command-line client may try the configured TCP host even when a socket is passed explicitly, returning a misleading connection error while the local API still works.

**Why:** Development MySQL environment variables from the Replit workspace influence the CLI client; a socket option alone did not prevent a TCP connection attempt.

**How to apply:** For manual maintenance on the isolated test database, unset the MYSQL_* connection variables for that one command and specify `--no-defaults`, `--protocol=SOCKET`, `--host=localhost`, and the socket path. Do not unset the variables in the application workflow. Never use this to touch the Plesk database.