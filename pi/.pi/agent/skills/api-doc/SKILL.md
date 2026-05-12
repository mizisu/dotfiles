---
name: api-doc
description: Extract concise API documentation from backend code when explicitly invoked with an HTTP method and path. Traces Django/DRF endpoints to produce request/response JSON without inventing fields.
disable-model-invocation: true
---

# api-doc

Use this skill when the user gives an API endpoint such as:

```text
GET /api/goal/cycles/{goal_cycle_entity_id}/items/{entity_id}/
```

Goal: produce a concise request/response API document from the actual code.

## Workflow

1. Find the URL route.
   - Search `urls.py`, DRF routers, `path()`, `re_path()`, and `@action` routes.
2. Find the view/action.
   - Identify the ViewSet/APIView method for the HTTP method.
3. Find request shape.
   - List path params, query params, and body serializer.
   - For `GET`, body is usually `{}` unless code says otherwise.
4. Find response shape.
   - Prefer response serializer/schema.
   - Then trace service/query return DTOs only as needed.
   - Recursively inspect nested serializers/fields.
5. Verify constants.
   - Never guess enum values.
   - Check `IntegerChoices`, `TextChoices`, constants, and model fields in source.
6. Write the document.

## Output Format

Follow the user's requested output style and scope first.

If the user does not specify a format, return only this simple API shape:

````md
# Endpoint

```text
GET /api/.../
```

# Request

```json
{}
```

# Response

```json
{
  "entity_id": "..."
}
```
````

Do not include source trace, field notes, explanations, or extra sections unless the user explicitly asks.

## Rules

- Do not invent fields that are not proven by code.
- Use pure `json` blocks for valid JSON.
- Do not include comments inside JSON.
- Prefer one clear example over exhaustive schema generation.
