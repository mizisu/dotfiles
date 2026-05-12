---
name: frontend-style
description: Frontend coding conventions for the lemonbase app. Covers React component design, TypeScript patterns, API layer structure, state management, testing, and code organization. Use when writing or reviewing frontend code in this project.
disable-model-invocation: true
---

# Frontend Code Style Guide

This guide defines code style and design decisions for the lemonbase frontend codebase. Follow these patterns when writing new code or refactoring existing code.

## Companion Skills

When this skill is activated, compose it with the shared guard skill and the current project's Lemonbase skills.

- Always read `../simplicity-guard/SKILL.md` from this skill directory.
- For companion skills whose names start with `lb-`, read the project-local skill from the active codebase instead of a sibling of this global skill. Locate them from the current project/worktree (`cwd` and ancestors), then read the located absolute file path; do not resolve `lb-*` relative to this `frontend-style` skill directory.
- If they exist, read the nearest project-local `lb-design`, `lb-lds`, and `lb-react-rules` skills (for example `<active-project-root>/.pi/skills/lb-design/SKILL.md`, `<active-project-root>/.pi/skills/lb-lds/SKILL.md`, `<active-project-root>/.pi/skills/lb-react-rules/SKILL.md`, or their `<active-project-root>/.agents/skills/...` equivalents).
- Treat those skills as additive constraints alongside this guide. If two rules seem to conflict, prefer the rule that is more specific to the code you are changing and surface any real conflict explicitly.

---

## TypeScript Foundations

### `type` over `interface`

Use `type` for all type definitions. `interface` is reserved for rare cases that genuinely require declaration merging.

```tsx
// ✅
type Props = {
  name: string;
  onSubmit: (value: string) => void;
};

// ❌
interface Props {
  name: string;
  onSubmit: (value: string) => void;
}
```

### Let the compiler work for you

Prefer inferred types over explicit annotations. Add a type only when it communicates something inference cannot.

Use `ReturnType<typeof fn>` when you need a function's return type, `satisfies` when you want to validate shape without widening inference, and `as const` when you need to preserve literal values.

```tsx
// ✅ — inferred from defaultValues + resolver
const { control, handleSubmit } = useForm({
  defaultValues: { name: '', parentEntityId: null },
  resolver: zodResolver(formSchema()),
});

// ✅ — preserve inference while checking the contract
const statusOptions = [
  { value: 'draft', label: t`임시 저장` },
  { value: 'submitted', label: t`제출됨` },
] as const satisfies ReadonlyArray<{ value: string; label: string }>;

// ✅ — reuse a function's return type without re-declaring it
type InferredFormValues = ReturnType<typeof getDefaultValues>;

// ❌ — manually duplicating what the compiler already knows
type FormValues = z.infer<ReturnType<typeof formSchema>>;
const { control, handleSubmit } = useForm<FormValues>({ ... });
```

### Use type guards instead of `as`

Avoid `as`. A cast is a promise to the compiler that may not be true at runtime. Prefer type guards or discriminated unions. Only use `as` when external library type limits make it unavoidable.

```tsx
// ✅
function isPerson(value: unknown): value is Person {
  return typeof value === 'object' && value !== null && 'entityId' in value;
}

if (!isPerson(payload)) return;
showPerson(payload);

// ❌
showPerson(payload as Person);
```

### Model the domain accurately

Types should reflect how data actually behaves. Narrow the type rather than widening it — remove impossible states.

```tsx
// ✅ — the person is resolved before this component renders
type Props = {
  person: Person;
};

// ❌ — pushes null-checking to every consumer
type Props = {
  person: Person | undefined;
};
```

When a function only works with a subset of an entity, name it for what it does without unnecessary qualifiers.

```tsx
// ✅
function getPerson(entityId: string): Person { ... }

// ❌ — "Active" qualifier may be redundant if inactive people are never in the dataset
function getActivePerson(entityId: string): Person | undefined { ... }
```

Before adding a frontend-only filter (e.g. filtering out inactive items), confirm whether the backend already handles it. Avoid duplicating logic across layers.

The same principle applies to Zod schemas: use the most precise validator that matches the domain. If a field holds a UUID, use `z.uuid()` — not `z.string()` or `z.string().min(1)`.

```tsx
// ✅ — schema reflects the actual data shape
body: z.object({
  personEntityIds: z.array(z.uuid()),
  parentEntityId: z.uuid().nullable(),
}),

// ❌ — too loose; accepts any string
body: z.object({
  personEntityIds: z.array(z.string()).min(1),
  parentEntityId: z.string().nullable(),
}),
```

### Narrow nullable values before access

Do not use `?.` on values that are not nullable. When a value is nullable, narrow it first with an early return or type guard, then access it normally.

```tsx
// ✅
if (!person) return null;
return <UserProfile person={person} avatarUrl={person.avatarUrl} />;

// ❌ — hides that `person` should be narrowed first
return <UserProfile person={person} avatarUrl={person?.avatarUrl} />;
```

### Reuse enum TypeMaps

When an enum already has a metadata map with translated labels (e.g. `XxxTypeMap[value].text`), use `getEnumValues` + `.map()` to generate options. Don't manually duplicate the labels.

```tsx
// ✅ — single source of truth for labels
const options = getEnumValues(GoalItemApprovalStatusType).map(type => ({
  value: type,
  label: GoalItemApprovalStatusTypeMap[type].text,
}));

// ❌ — labels duplicated from the TypeMap
const options = [
  { value: GoalItemApprovalStatusType.DRAFT, label: t`승인 요청 전` },
  { value: GoalItemApprovalStatusType.IN_PROGRESS, label: t`승인 대기 중` },
  { value: GoalItemApprovalStatusType.APPROVED, label: t`승인 완료` },
  { value: GoalItemApprovalStatusType.REJECTED, label: t`반려` },
];
```

The same applies to table column titles — prefer `TypeMap[value].text` over manual `t` strings.

### Prefer named exports

Named exports make it easier to trace usages and avoid accidental name collisions. Default export is reserved for **page components only** (to match router conventions).

```tsx
// ✅ component / hook / utility
export function ReviewCycleTable() { ... }
export function useReviewCycleFolderSelection() { ... }

// ✅ page entry point — default export
export default function ReviewCycleManagePage() { ... }
```

### Eliminate unused exports

When an export loses its last consumer, remove it. Unused exports are dead code — they add noise, bloat bundles, and create the illusion of a public API that nobody uses.

### Watch for circular references

Be deliberate about import direction. When module A depends on B and B starts to depend on A, extract the shared piece into a third module rather than creating a cycle.

### Use exhaustive switches for enum/union transformations

When transforming an enum or discriminated union, use `switch` with `shouldBeNeverType` so new variants fail at compile time. Avoid implicit fallback branches like "otherwise TEXT/NUMBER".

```tsx
// ✅ — adding a new GoalCustomFieldType produces a compile error here
switch (customField.type) {
  case GoalCustomFieldType.SELECT:
    return { ...common, type: customField.type, options: normalizeOptions(customField.options) };
  case GoalCustomFieldType.RATING_CRITERIA:
    return { ...common, type: customField.type, ratingCriteria: normalizeCriteria(customField.ratingCriteria) };
  case GoalCustomFieldType.TEXT:
  case GoalCustomFieldType.NUMBER:
    return { ...common, type: customField.type };
  default:
    return shouldBeNeverType(customField);
}

// ❌ — a future enum member silently falls through
if (customField.type === GoalCustomFieldType.SELECT) return { ... };
if (customField.type === GoalCustomFieldType.RATING_CRITERIA) return { ... };
return { ...common, type: customField.type };
```

### Avoid identical type aliases

Don't create a new type name if it is only an alias for the same shape. It suggests a boundary that does not really exist.

```tsx
// ✅ — one name because the shapes are actually the same
type GoalCycleCommonRequest = {
  goalItemCustomFields?: GoalCustomFieldInput[];
};

// ❌ — two names, no additional constraint
export type GoalCustomFieldRequest = GoalCustomFieldInput;
```

Create a separate request/input type only when the shape or constraints really differ.

---

## React Rules

### Read the shared React rules first

Before writing or editing a React component, read the current project's `lb-react-rules` skill if it exists: locate the nearest ancestor containing `.pi/skills/lb-react-rules/SKILL.md` or `.agents/skills/lb-react-rules/SKILL.md`, read that absolute file path, and apply it together with this guide. This is already part of the companion-skill flow above, so treat it as an automatic cross-reference rather than an optional reminder.

## Component Design

### Prefer composite components over primitive + manual prop spreading

When a higher-level component exists that composes layout, avatar, and metadata together, use it instead of assembling the same pieces by hand with a primitive component and a prop-spreading helper.

```tsx
// ✅ — UserProfile handles avatar + displayName layout internally
<UserProfile person={person} metadata={{ show: false }} size="xSmall" />

// ❌ — manual assembly of the same result
<Avatar {...personToAvatarProps(person)} size="xSmall">
  <span className="typography-caption1 text-secondary">{person.displayName}</span>
</Avatar>
```

Smell: `...someToPropsHelper(x)` spread on a primitive component — check if a composite component already exists.

### Prefer component props over `className` for layout

When an LDS component exposes a typed prop (e.g. `width`), use it instead of a Tailwind `className`. The prop is part of the component's API contract and keeps styling colocated with the component's implementation.

```tsx
// ✅ — uses the Select's width prop
<Select width={180} ... />
<SearchInput width={180} ... />

// ❌ — bypasses the component API with a raw class
<Select className="min-w-[180px]" ... />
```

### Pass specific values, not state bags

When a child component only needs a few values from a parent's state, pass them as individual props. Don't forward an entire state object — it hides the actual dependency surface and couples the child to the parent's internal shape.

```tsx
// ✅ — child declares exactly what it needs
type Props = {
  searchKeyword: string;
  approvalStatusFilter: number[];
  selectedRowKeys: string[];
  setSelectedRowKeys: (keys: string[]) => void;
};

<ApproveeStatsTable
  searchKeyword={debouncedSearchKeyword}
  approvalStatusFilter={tab.approvalStatusFilter}
  selectedRowKeys={tab.selectedRowKeys}
  setSelectedRowKeys={tab.setSelectedRowKeys}
/>

// ❌ — opaque state bag; child coupled to parent's internal type
type Props = {
  tabState: TabState;
};

<ApproveeStatsTable tabState={tab} />
```

### Name props from the receiver's perspective

A prop name should describe what the data **is** to the receiving component, not how the caller **produced** it. Implementation details like debouncing, throttling, or memoization are the caller's concern — they should not leak into the child's API.

```tsx
// ✅ — component just knows it receives a search keyword
type Props = {
  searchKeyword: string;
};

export function ApproveeStatsTable({ searchKeyword }: Props) {
  const filtered = items.filter(item => isKeywordsMatches(searchKeyword, item.name));
}

// ❌ — "debounced" is the caller's implementation detail leaking in
export function ApproveeStatsTable({
  searchKeyword: debouncedSearchKeyword,
}: Props) {
  const filtered = items.filter(item => isKeywordsMatches(debouncedSearchKeyword, item.name));
}
```

Smell: destructuring에서 prop을 rename하면서 `debounced`, `memoized`, `throttled` 같은 접두어를 붙이고 있다면, 그 이름은 호출자의 관심사가 컴포넌트로 누출된 것이다.

### Inline what has a single use

If a piece of UI appears in exactly one place, keep it inline. Extracting a component or hook that nobody else reuses adds indirection without benefit.

```tsx
// ✅ — popover content defined inline where it's used
<PopoverAnatomy.Content>
  <div>
    {rules.map((rule, i) => (
      <div key={i} className="flex items-center gap-1 py-1">
        <CheckIcon className={errors[i] ? 'text-gray-300' : 'text-accent-main'} />
        <span>{rule}</span>
      </div>
    ))}
  </div>
</PopoverAnatomy.Content>

// ❌ — needless PasswordHintList component used only here
<PopoverAnatomy.Content>
  <PasswordHintList rules={rules} errors={errors} />
</PopoverAnatomy.Content>
```

The same applies to custom hooks: if a hook wraps a single `useState` + effect for one component, keep the logic in that component.

Exception: split single-use components when they represent distinct domain variants. If one component has many `type`/`mode` branches, different schemas, different required fields, or different submit payloads, splitting by variant is simpler even if each child has one caller.

```tsx
// ✅ — each modal has one fixed schema and one output shape
<PlainTypeFormModal fieldType={GoalCustomFieldType.TEXT} ... />
<SelectTypeFormModal ... />
<RatingCriteriaTypeFormModal ... />

// ❌ — one modal knows every variant and branches internally
<GoalCustomFieldModal mode="edit" defaultValues={customField} ... />
```

Use a single discriminated-union form only when the discriminator is actually edited inside that form or the UI genuinely renders mixed variants together.

### Heavy logic belongs inside Modal/Drawer children

Hooks that fetch data or subscribe to stores should live inside the content component, not the wrapper that controls visibility. The wrapper stays light — it manages open/close state and renders the shell.

```tsx
// ✅ — wrapper is thin; heavy hooks are in content
function ProfileSummaryModal() {
  const [searchParams] = useSearchParams();
  const profilePersonEntityId = searchParams.get('profile') ?? undefined;
  const close = useCloseLogic();

  return (
    <Modal open={!!profilePersonEntityId} afterClose={close}>
      <ProfileSummaryContent profilePersonEntityId={profilePersonEntityId} />
    </Modal>
  );
}

// ❌ — all data-fetching hooks run even when modal is closed
function ProfileSummaryModal() {
  const { data } = useProfileSummaryInformation(entityId);
  const { people } = usePerson();
  // ...dozens more hooks...
  return <Modal>...</Modal>;
}
```

### Pure functions over hooks when no React primitives are needed

If the logic is data transformation without `useState`, `useEffect`, or context, extract it as a plain function. Pure functions are easier to test and have no React lifecycle coupling.

```tsx
// ✅ — pure function, easily testable
export function extractUniqueEmploymentFields(people: Person[]) {
  return {
    jobRoles: extractUnique(people, p => p.employment.jobRole),
    jobPositions: extractUnique(people, p => p.employment.jobPosition),
  };
}

// ❌ — wrapping a pure computation in a hook for no reason
function useProfileData() {
  const { people } = usePerson();
  const jobRoles = extractUniqueField(people.list, p => p.employment.jobRole);
  return { jobRoles };
}
```

### Return data, not side effects

Functions should produce values. Let the caller decide what to do with them — navigate, log, dispatch. This keeps logic testable and composable.

```tsx
// ✅ — returns a path; caller owns navigate()
const buildGoBackPath = () =>
  toPath(mode === 'edit' ? AppRoutePaths.TEMPLATES : AppRoutePaths.TEMPLATES_TYPE);

<WorkspaceAppBar.Close to={buildGoBackPath()} />

// ❌ — buries navigation inside a callback
function handleGoBack() {
  navigate(toPath(AppRoutePaths.TEMPLATES));
}
```

### Extract validation as pure predicates

When input validation logic grows beyond a single condition, pull it into a named boolean function. The name documents intent; the function is unit-testable.

```tsx
// ✅
function shouldPreventDecimalInputKey(event: KeyboardEvent, precision?: number): boolean {
  if (event.key === '.') return precision === 0 || event.currentTarget.value.includes('.');
  if (event.key === '-') return event.currentTarget.selectionStart !== 0 || event.currentTarget.value.includes('-');
  return !isNumberCharacter(event.key);
}

// ❌ — inline anonymous conditions scattered in onKeyDown
```

### Debounce at the state boundary

Use `useDebounce` to derive a debounced value from state, keeping the source `useState` responsive for instant UI feedback. Avoid wrapping event handlers in `lodash/debounce`.

```tsx
// ✅ — search input is responsive; filtering uses debounced value
const [keyword, setKeyword] = useState('');
const [debouncedKeyword, setDebouncedKeyword] = useState('');
useDebounce(() => setDebouncedKeyword(keyword), 500, [keyword]);

const filtered = useMemo(() => filterItems(items, debouncedKeyword), [items, debouncedKeyword]);

// ❌ — lodash debounce in a component leaks closures and can't be cleaned up
const debouncedFilter = debounce(value => onSearchKeywordChange(value), 500);
```

### Decompose fat components with domain-scoped hooks

When a component exceeds ~200 lines and mixes multiple concerns (viewport management, selection state, data fetching), extract **cohesive groups** of logic into hooks named after the domain they manage.

```tsx
// ✅ — Graph.tsx stays declarative; each hook encapsulates one domain
const orgSelections = useOrganizationSelection({ goalCycleEntityId, organizationTree });
const { focusNode, subscribeToVisibleNodes } = useViewportActions();
```

This is the counterbalance to "inline single-use": extract hooks when it genuinely reduces a component's cognitive load, not to hit a line-count target.

### Derive values instead of syncing state

When a value can be computed from existing data, compute it. Creating a separate store that syncs via `useEffect` introduces stale-state bugs.

```tsx
// ✅ — derived at render time
const currentReview = reviews.find(r => r.entityId === currentReviewEntityId);
const isSelfReview = currentReview?.reviewType === ReviewType.SELF;

// ❌ — global store + useEffect sync
const [, { setValue: setIsSelfReview }] = useIsSelfReviewStore();
useEffect(() => {
  setIsSelfReview(review?.reviewType === ReviewType.SELF);
  return () => setIsSelfReview(false);
}, [review?.reviewType]);
```

### Persist client identity for unsaved reorderable items

Editable/reorderable lists need stable React keys and DnD IDs. Use backend `entityId` when available; for unsaved items, generate a client `_key` once and preserve it in the owner state or form value until save.

Do not derive keys from editable values (`name`, `label`) or ordering (`index`, `order`). Do not call `v4()` during render or prop mapping unless the generated value is immediately stored and round-tripped. `useMemo` is not a reliable fix when values pass through AntD Form or another controlled parent that creates new references.

```tsx
// ✅ — once assigned, _key survives form-state round trips
type CustomFieldFormValue = CustomFieldInput & { _key?: string };

const [fields, setFields] = useControllableState<readonly InternalField[]>({
  prop: value?.map(field => ({ ...field, _key: field._key ?? field.entityId ?? v4() })),
  onChange: current => onChange?.(current.map((field, index) => ({ ...field, order: index + 1 }))),
});

// Request mapper explicitly picks request fields, so _key does not leak.

// ❌ — key changes when the user renames or reorders the item
const key = field.entityId ?? `${field.type}-${field.order}-${field.name}`;
```

---

## Performance

### Earn your `useMemo` / `useCallback`

Don't memoize speculatively. Add `useMemo` or `useCallback` only after identifying an actual performance problem — a measured slow render, an expensive computation, or a referential equality requirement for a downstream `React.memo`.

Most components re-render cheaply. Unnecessary memoization adds cognitive overhead and hides the true cost profile of the code.

### Avoid O(m×n) nested scans

Do not call `.find()`, `.includes()`, `.some()`, or `.filter()` inside `.map()`, `.filter()`, or `.forEach()` over another collection unless the data is obviously tiny and measurement shows it does not matter. Convert one side to a `Map` or `Set` first.

```tsx
// ✅ — precompute lookup once
const selectedIdSet = new Set(selectedIds);
const selectedPeople = people.filter(person => selectedIdSet.has(person.entityId));

// ❌ — repeated linear scan inside another loop
const selectedPeople = people.filter(person => selectedIds.includes(person.entityId));
```

---

## Data Fetching & API Layer

### Keep requests close to where data is consumed

The component (or the nearest parent) that uses the data should own the fetch. Avoid deep prop-drilling of fetched data or hoisting queries into unrelated ancestors.

```tsx
// ✅ — query lives next to the UI that renders it
function TemplateFolderList() {
  const { data: folders } = getTemplateFoldersAPI.useQuery();
  return <FolderExplorer folders={folders.folders} />;
}

// ❌ — fetched three levels up and threaded through props
function AdminPage() {
  const { data: folders } = getTemplateFoldersAPI.useQuery();
  return <SettingsPanel folders={folders}> ... </SettingsPanel>;
}
```

### Contracts define the API shape

Define every endpoint with `createQueryAPI` or `createMutationAPI` plus Zod schemas. The contract is the single source of truth for path, params, query, body, and response shape.

Zod schemas and TypeScript types must always use camelCase keys. Do not manually camelize or decamelize payloads — the axios interceptor already applies `decamelizeKeys` for requests and `camelcase-keys` for responses.

```tsx
export const getTemplateFoldersAPI = createQueryAPI({
  method: 'GET',
  path: '/api/folders/template/',
  response: z.object({
    folders: z.array(
      z.object({
        entityId: z.uuid(),
        name: z.string(),
        parentEntityId: z.uuid().nullable(),
        sortOrder: z.number(),
      }),
    ),
  }),
});

export const createTemplateFolderAPI = createMutationAPI({
  method: 'POST',
  path: '/api/folders/template/',
  body: z.object({
    name: z.string(),
    parentEntityId: z.uuid().nullable(),
  }),
  response: z.object({
    entityId: z.uuid(),
    name: z.string(),
    parentEntityId: z.uuid().nullable(),
    sortOrder: z.number(),
  }),
});
```

Legacy `axios` wrapper classes should be replaced with contract-based APIs when touched.

### Normalize response/form/request shapes at boundaries

Do not let UI components accept both server response shapes and form input shapes. If the API response differs from the form shape, normalize it before passing it into the component. Put response/request conversions in the data mapper layer, not in a catch-all UI `utils.ts`.

```tsx
// ✅ — response shape is normalized before it reaches the form component
export function goalCustomFieldFromResponse(field: GoalCustomField): GoalCustomFieldInput {
  const common = pickCommonFieldValues(field);

  switch (field.type) {
    case GoalCustomFieldType.SELECT:
      return { ...common, type: field.type, options: field.options };
    case GoalCustomFieldType.RATING_CRITERIA:
      return { ...common, type: field.type, ratingCriteria: field.ratingCriteria };
    case GoalCustomFieldType.TEXT:
    case GoalCustomFieldType.NUMBER:
      return { ...common, type: field.type };
    default:
      return shouldBeNeverType(field.type);
  }
}

<Form.Item initialValue={goalCycle.goalItemCustomFields.map(goalCustomFieldFromResponse)}>
  <GoalCustomFieldSection />
</Form.Item>

// ❌ — component accepts response/input/internal shapes and normalizes inside UI utils
type EditableCustomField = GoalCustomField | GoalCustomFieldInput;
```

Boundary mapper functions should usually have explicit return types so response-only fields and UI-only fields cannot leak across layers.

### Use `fallbackData` and Suspense patterns for loading states

Prefer SWR's `fallbackData` to initial-loading spinners when a reasonable default exists. Use Suspense boundaries for declarative loading when the architecture supports it. The goal is to make the happy path the default code path.

### Centralize form validation in `zodResolver`

Define all field validations in a single Zod schema passed to `zodResolver`. Don't scatter `rules` across individual `FormControlField` components — it splits the validation contract across the template and makes it hard to see the full picture.

```tsx
// ✅ — all validation in one place
const { control, handleSubmit } = useForm({
  defaultValues: getRemindDefaultValues(goalCycleName)[target],
  resolver: zodResolver(
    z.object({
      title: z.string().trim().nonempty({ error: t`제목을 입력해주세요.` }),
      content: z.string().refine(value => !isContentEmpty(value), {
        error: t`본문을 입력해주세요.`,
      }),
    }),
  ),
});

<FormControlField control={control} name="title" label={t`제목`}
  render={({ field, fieldState }) => (
    <Input {...field} size="large" status={fieldState.error ? 'error' : undefined} />
  )}
/>

// ❌ — validation scattered across each FormControlField
const { control, handleSubmit } = useForm({
  defaultValues: getRemindDefaultValues(goalCycleName)[target],
});

<FormControlField control={control} name="title" label={t`제목`}
  rules={{ required: t`제목을 입력해주세요.` }}
  render={({ field, fieldState }) => (
    <Input {...field} status={fieldState.error ? 'error' : undefined} />
  )}
/>
```

### Resolve `defaultValues` before rendering

For forms, compute `defaultValues` from already-available data rather than patching them after mount. Lazy `zodResolver(formSchema())` evaluation ensures i18n messages are fresh per render.

```tsx
// ✅ — resolver is freshly evaluated; defaultValues are stable
const { control } = useForm({
  resolver: zodResolver(formSchema()),
  defaultValues: { scheduleDate },
});

// ❌ — resolver captured at module level; stale i18n
const FormSchemaResolver = zodResolver(formSchema());
```

### Reset form state from canonical data after save

When a mutation creates server IDs, canonical ordering, or other normalized values, avoid injecting raw response objects into nested form fields. Prefer refetching/mutating the canonical data source, normalizing through the mapper, and resetting only the affected field if needed.

```tsx
// ✅ — refetch canonical data, then remount the field with normalized initialValue
await goalCycleList.refetch();
setCustomFieldsResetKey(key => key + 1);

<Form.Item
  key={customFieldsResetKey}
  initialValue={goalCycle.goalItemCustomFields.map(goalCustomFieldFromResponse)}
>
  <GoalCustomFieldSection />
</Form.Item>

// ❌ — raw response shape is patched directly into a nested form value
form.setFieldValue('customFields', updatedGoalCycle.goalItemCustomFields);
```

Also ensure primary-save synchronization is not blocked by secondary side effects. If a follow-up API call can fail independently, use `try`/`finally` or split the flow so refetch/reset still happens after the primary save succeeds.

---

## Frontend Architecture

### Prefer links for navigation

If navigation can be represented as a link, use `<Link>`.

When navigation must happen in an `onClick`, preserve Cmd/Ctrl+Click for a new tab and Shift+Click for a new window by using `useAdvancedNavigation` and passing the original event.

```tsx
// ✅
<Link to={toPath(AppRoutePaths.REVIEW_CYCLES)}>...</Link>

// ✅
const advancedNavigate = useAdvancedNavigation();

function handleRowClick(
  event: React.MouseEvent<HTMLButtonElement>,
  entityId: string,
) {
  advancedNavigate(
    toPath(AppRoutePaths.REVIEW_CYCLE_DETAIL, { entityId }),
    event,
  );
}

// ❌
function handleRowClick() {
  navigate(toPath(AppRoutePaths.REVIEW_CYCLE_DETAIL, { entityId }));
}
```

### Translate all user-visible strings

All user-facing strings must be wrapped for LinguiJS translation — JSX text, button labels, empty states, toast messages, validation errors, column titles, and any other UI copy.

For bulk Korean-string migrations, prefer the codemod instead of editing each string by hand.

```bash
pnpm codemod:translate:run src/path/to/file.tsx
```

---

## State Management

### Remove third-party state libraries when the platform suffices

If a store just holds a single value and pipes it through `setState`, replace it with a local `useState`, a computed value, or a lightweight Jotai atom. The pattern of removing `react-sweet-state` in favor of contracts + SWR cache is the canonical migration path.

### Mutate after mutation, not via a store action

After a successful API call, revalidate the relevant SWR cache — don't manually push the new value into a global store.

```tsx
// ✅
await deleteAgendaCommentAPI.trigger({ params });
getAgendasAPI.mutate({ params: { oneOnOneEntityId, scheduleEntityId } });

// ❌
await actions.deleteAgendaComment(agendaEntityId, commentEntityId);
```

---

## Testing

### Test pure logic with pure tests

When you extract a pure function, write focused unit tests for it. Use descriptive Korean test names that read as specs.

```tsx
describe('extractUniqueEmploymentFields', () => {
  it('빈 배열이면 모든 필드가 빈 배열이다', () => { ... });
  it('중복 값은 제거된다', () => { ... });
  it('빈 문자열은 falsy로 제외된다', () => { ... });
});
```

### Helper factories for test data

Create a `createXxx` factory function with sensible defaults and a `Partial` override parameter. This keeps each test case focused on the data that matters.

```tsx
function createPerson(
  overrides: Partial<Person> & { entityId: string },
): Person {
  return {
    firstName: '길동',
    lastName: '홍',
    accountStatus: AccountStatus.ACTIVE,
    ...overrides,
  };
}
```

### Mock at the network layer

Use MSW + contract-based `mockAPI` helpers. Mock responses should follow the Zod schema shape, not the raw snake_case backend format.

```tsx
// ✅
mockAPI(getPeople, [{ entityId: '...', firstName: '레몬', ... }]);

// ❌ — hardcoded path + snake_case
http.get(mockAPIPath('/people/'), () => HttpResponse.json([{ entity_id: '...' }]));
```

---

## Code Hygiene

### Error propagation

When a network request fails inside an `async` action, re-throw after showing the error message so callers know the operation failed.

```tsx
} catch (error) {
  showErrorMessage(error, t`폴더 이동에 실패했습니다.`);
  throw error;
}
```

### Safe index access

Use `.at(0)` for array access that might be empty. Handle the `undefined` case explicitly instead of trusting the array is non-empty.

```tsx
// ✅
const topOrg = organizationList.at(0);

// ❌ — crashes if empty
const topOrg = organizationList[0];
```

### Remove dead dependencies

When a migration eliminates the last usage of a package (`prop-types`, `react-responsive`, `react-sweet-state`), remove it from `package.json` in the same PR. Don't leave orphan dependencies.

### Use ts-belt utilities over manual array transforms

Prefer `A.filterMap` from `@mobily/ts-belt` over `flatMap` with manual null-check boilerplate. The utility communicates intent more clearly and is already the project convention.

```tsx
// ✅ — declarative: map + filter nulls in one pass
const receivers = A.filterMap(receiverEntityIds, getPerson);

// ❌ — imperative boilerplate
const receivers = receiverEntityIds.flatMap(entityId => {
  const person = getPerson(entityId);
  return person ? [person] : [];
});
```

### Avoid catch-all UI `utils.ts` files

Before creating a `utils.ts`, identify the boundary each function belongs to.

- API response/request conversion → data mapper layer
- modal default/submit conversion → modal or caller
- UI-only key/order management → state owner component
- reused domain calculation → named domain utility

If a file mixes response normalization, form defaults, request conversion, and UI keys, split the responsibilities or inline the single-use logic where it belongs.

### Codemods for cross-cutting changes

When a pattern must be updated across many files (e.g., replacing `overlay.open` with `useOverlay`, or wrapping Korean strings with `<Trans>`), write a codemod script with input/expected test fixtures rather than editing each file by hand. Fixture-driven codemods are self-documenting and catch regressions.
