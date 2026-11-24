# Docker stack (needs Docker Desktop). On Windows without GNU make: mingw32-make <target>
COMPOSE ?= docker compose
PY ?= backend/venv/Scripts/python.exe

.PHONY: up down logs ps test

up:
	$(COMPOSE) up --build -d

# Keeps the appdata volume (history survives). Use "docker compose down -v" to wipe it.
down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps

test:
	$(PY) -m pip install -q -r backend/requirements-dev.txt
	cd backend && ../$(PY) -m pytest -q -p no:cacheprovider --basetemp=.pytest_tmp
	cd frontend && npm test -- --run
