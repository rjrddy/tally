"""Provision owner-only local synthetic credentials, never display the values."""

import os
import secrets

values = (
    "\n".join(
        f"{key}={secrets.token_urlsafe(32)}"
        for key in ["TALLY_PASSWORD", "TALLY_TOKEN", "TALLY_DB_PASSWORD", "TALLY_DB_ADMIN_PASSWORD"]
    )
    + "\n"
)
fd = os.open(".env", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write(values)
print("Created ignored .env with owner-only permissions; open locally for the operator password.")
