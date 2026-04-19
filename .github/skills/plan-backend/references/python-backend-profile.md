---
summary: Python backend profile — framework-tagged principle checks + stack commands + anti-patterns.
---

# Python Backend Profile

Applied when `detect-stack` reports `stack: 'python'` or `'mixed'` with
Python files cited in the task.

## File-layout expectations

- `src/<pkg>/` or `<pkg>/` — package root
- `routes/` / `api/` / `views/` — HTTP boundary
- `services/` / `domain/` — business logic
- `models/` / `schemas/` — data shapes (SQLAlchemy / Django ORM + Pydantic)
- `migrations/` — schema evolution
- `tests/` — pytest

## Framework-tagged principle checks

- `[generic]` Type hints on function signatures + returns (`mypy --strict` clean)
- `[generic]` Exception hierarchy (custom `AppException` base, no bare `except:`)
- `[generic]` Pytest for testing, ruff for lint + format
- `[generic]` Virtual environment discipline (venv/poetry/uv)
- `[generic]` ORM N+1 prevention — Django: `select_related`/`prefetch_related`; SQLAlchemy: `joinedload`/`selectinload`
- `[generic]` No mutable default arguments in function signatures
- `[fastapi]` Async consistency — whole request path async, no sync DB calls in async handlers
- `[fastapi]` `Depends()` for dependency injection, not module-level singletons
- `[fastapi,flask]` `pydantic-settings` BaseSettings for config (Django uses `settings.py`)
- `[fastapi,flask]` Pydantic validation at API boundaries, not dict-bashing
- `[django]` Fat-view anti-pattern — move business logic to services
- `[django]` Django forms for validation before DB writes
- `[django,flask]` HTMX progressive enhancement (Django/Flask templates)

## Stack commands

```bash
pytest                         # test runner
ruff check                     # lint
ruff format                    # format
mypy  # or: pyright            # type-check
uv sync  # or: poetry install  # deps
```

## Python-specific anti-patterns

- Global DB session (must be per-request)
- Sync-in-async (sync DB calls inside async handlers)
- `Any`-typed returns (use explicit return types)
- Dict-passing across boundaries (use Pydantic models or dataclasses)
- Django fat views (business logic in views instead of services)
