# Page Types

Wiki page types are defined in `brain.config.yaml` → `page_types`. Each type represents a distinct editorial purpose in your knowledge base.

## Defining types

```yaml
# brain.config.yaml
page_types:
  - topic
  - concept
  - decision
  - reference
  - entity
```

The agent validates the `type` field in every wiki page's frontmatter against this list.

## Adding type-specific fields

Use `type_fields` to define extra frontmatter fields for specific page types:

```yaml
type_fields:
  decision:
    - decision_date
    - decision_status       # proposed | accepted | superseded | deprecated
    - options               # list of alternatives considered
  entity:
    - entity_type           # product | organisation | system | role
    - aliases               # alternative names
```

These fields are added to the base template when creating a page of that type.

## Base fields (all types)

Every page gets these fields regardless of type:

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Human-readable page title |
| `type` | yes | Must be in `brain.config.yaml` → `page_types` |
| `tier` | yes | `canonical`, `curated`, or `evidence` |
| `tags` | no | Lowercase filter tags |
| `status` | yes | `stub`, `draft`, or `evergreen` |
| `confidence` | yes | `high`, `medium`, `low`, or `unknown` |
| `owner` | no | Required only when `brain.config.yaml` → `require_owner` is `true`, in which case it must be in `owner_teams` |
| `date_created` | yes | ISO date |
| `date_modified` | yes | ISO date |
| `last_verified` | no | ISO date — last human check |
| `sources` | yes | List of raw files or remote references |
| `related` | no | Explicit `[[wikilinks]]` |

## Example: adding a custom type

To add a `process` type for documenting workflows:

1. Add to `brain.config.yaml`:
   ```yaml
   page_types:
     - topic
     - concept
     - decision
     - reference
     - entity
     - process           # new

   type_fields:
     process:
       - steps            # ordered list of process steps
       - owner_role       # who executes this process
       - frequency        # how often it runs
   ```

2. The agent will now accept `type: process` in wiki pages and prompt for the extra fields when creating one.
