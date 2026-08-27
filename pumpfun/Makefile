PY := .venv/bin/python
VENV := .venv

.PHONY: dev check test cov lint types run check-config clean

dev: $(VENV)
	$(PY) -m pip install -q -r requirements-dev.txt
	$(MAKE) check

$(VENV):
	python3 -m venv $(VENV)
	$(PY) -m pip install -q --upgrade pip

check: lint types test

lint:
	$(PY) -m ruff check src tests scripts

types:
	$(PY) -m mypy src

test:
	$(PY) -m pytest -q

cov:
	$(PY) -m pytest --cov=src --cov-report=term-missing

check-config:
	$(PY) -m src.pipeline --config config.yaml --check

run:
	$(PY) -m src.pipeline --config config.yaml

clean:
	rm -rf .pytest_cache .mypy_cache .ruff_cache __pycache__ */__pycache__
