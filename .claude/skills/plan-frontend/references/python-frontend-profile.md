---
summary: Python frontend profile — Jinja/Django/Flask template patterns + HTMX + anti-patterns.
---

# Python Frontend Profile

Applied when `detect-stack` reports `stack: 'python'` or `'mixed'` with
the task's cited files being Python/Jinja. Covers server-rendered
frontends — the dominant Python "frontend" pattern.

## File-layout expectations

- `templates/` — Jinja / Django / Flask templates
- `static/` — CSS, JS, images served by the framework
- `frontend/` — optional separate JS build folder

## Framework-tagged principle checks

- `[generic]` Template inheritance — base template with blocks, child templates extend
- `[generic]` Static asset versioning — cache-busting via hashed filenames or query params
- `[generic]` Server-side form validation — never trust client-only validation
- `[generic]` Context data discipline — explicit context dicts, no global state leaking into templates
- `[django]` CSRF on all mutation forms (`{% csrf_token %}`)
- `[django]` Use Django template tags and filters instead of logic in templates
- `[django]` `{% static %}` tag for all asset references (not hardcoded paths)
- `[django,flask]` HTMX progressive enhancement — server returns HTML fragments, not JSON
- `[django,flask]` No direct ORM access from templates (pass pre-computed data from views)
- `[flask]` Jinja2 autoescaping enabled by default; `|safe` filter requires explicit justification

## Python frontend anti-patterns — flag these in the plan

- Logic in templates (conditionals / loops that should be in views or services)
- `|safe` filter without justification (XSS risk)
- Direct ORM access from templates (N+1 queries, separation of concerns)
- Hardcoded asset paths instead of `{% static %}` or `url_for('static', ...)`
- Missing CSRF tokens on POST / PUT / DELETE forms
- Client-side-only validation (must always be mirrored server-side)

## When you see a Python frontend plan

Cite these principles alongside the Gestalt / interaction / cognitive-load
tables (`references/ux-principles.md`) — don't replace them. A Jinja
template still needs good proximity, hierarchy, and state coverage; the
Python profile adds the framework-specific rules.
