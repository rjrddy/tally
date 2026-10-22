ifneq ($(wildcard .cache/runtime/node_modules/node/bin/node),)
export PATH := $(CURDIR)/.cache/runtime/node_modules/node/bin:$(PATH)
endif
ENVFILE := $(if $(wildcard .env),--env-file=.env,)
.PHONY: setup build lint test bench demo scan native-db native-stop
setup:
	npm ci
	npm --prefix apps/web ci
	python3 -m venv .venv
	.venv/bin/pip install --upgrade pip==26.2.2 setuptools==84.0.0
	.venv/bin/pip install -r requirements-dev.txt
build:
	npm run build
	npm --prefix apps/web run build
lint:
	npm run lint
	npm --prefix apps/web run lint
	.venv/bin/ruff check scripts
	.venv/bin/ruff format --check scripts
test:
	node $(ENVFILE) --test --test-concurrency=1 dist/tests/*.test.js
bench:
	node $(ENVFILE) dist/scripts/bench.js
native-db:
	python3 scripts/native_db.py start
	node $(ENVFILE) dist/scripts/migrate.js
native-stop:
	python3 scripts/native_db.py stop
demo:
	docker compose up --build --wait
scan:
	npm audit --audit-level=high
	npm --prefix apps/web audit --audit-level=high
