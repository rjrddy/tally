"""Owned loopback-only Postgres cluster, separate from all existing project databases."""

import argparse
import os
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["start", "stop"])
args = parser.parse_args()
bindir = Path(subprocess.check_output(["pg_config", "--bindir"], text=True).strip())
root = Path(".cache/postgres").resolve()
root.mkdir(parents=True, exist_ok=True)
data = root / "data"
env = dict(os.environ)
for line in Path(".env").read_text().splitlines():
    key, value = line.split("=", 1)
    env[key] = value
if args.action == "stop":
    subprocess.run([str(bindir / "pg_ctl"), "-D", str(data), "-m", "fast", "stop"], check=True)
else:
    if not (data / "PG_VERSION").exists():
        password = root / "bootstrap.password"
        fd = os.open(password, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(env["TALLY_DB_ADMIN_PASSWORD"])
        subprocess.run(
            [
                str(bindir / "initdb"),
                "-D",
                str(data),
                "--username=tally_admin",
                "--pwfile=" + str(password),
                "--auth=scram-sha-256",
                "--encoding=UTF8",
                "--locale=C",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
    if subprocess.run(
        [str(bindir / "pg_ctl"), "-D", str(data), "status"], stdout=subprocess.DEVNULL
    ).returncode:
        subprocess.run(
            [
                str(bindir / "pg_ctl"),
                "-D",
                str(data),
                "-l",
                str(root / "server.log"),
                "-o",
                "-h 127.0.0.1 -p 55440 -k " + str(root) + " -c fsync=on -c synchronous_commit=on",
                "start",
            ],
            check=True,
        )
    env["PGPASSWORD"] = env["TALLY_DB_ADMIN_PASSWORD"]
    existing = subprocess.check_output(
        [
            str(bindir / "psql"),
            "-h",
            "127.0.0.1",
            "-p",
            "55440",
            "-U",
            "tally_admin",
            "-d",
            "postgres",
            "-Atc",
            "SELECT 1 FROM pg_database WHERE datname='tally'",
        ],
        env=env,
        text=True,
    )
    if not existing.strip():
        subprocess.run(
            [
                str(bindir / "createdb"),
                "-h",
                "127.0.0.1",
                "-p",
                "55440",
                "-U",
                "tally_admin",
                "tally",
            ],
            env=env,
            check=True,
        )
    print("Owned Tally Postgres ready on loopback 55440; fsync and synchronous_commit enabled.")
