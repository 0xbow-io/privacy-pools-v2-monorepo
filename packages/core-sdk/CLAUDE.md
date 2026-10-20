# SDK Package — Coding Standards

## Pre-Flight Checklist

Before writing or modifying any SDK code, verify against these rules:

- [ ] **Imports** — Every import in `src/` AND `test/` goes through `internal.ts`, never a direct file path
- [ ] **Method order** — All public methods ABOVE all private methods; caller above callee
- [ ] **Constructor** — Dependencies via typed config object, never loose parameters
- [ ] **JSDoc interface** — `@throws` references ONLY the base error, never specific subclasses
- [ ] **JSDoc implementation** — `@inheritdoc` (lowercase d) + one `@throws` per specific exception
- [ ] **Public API types** — All values entering/leaving a service are `Hex`, never raw numbers or `Uint8Array`
- [ ] **Test names** — Start with a verb, NEVER with "should"

---

## 1. Internal Barrel Imports

**When:** writing any `import` statement in `src/` or `test/` files.

All intra-package imports MUST go through `src/internal.ts`. This applies to **both source and test files**.

```ts
// GOOD
import { Hex, MerkleService, IHashService } from "../internal.js";

// BAD — direct path import (even in test files)
import { Hex } from "../types/Hex.js";
import { MerkleService } from "../services/MerkleService.js";
import type { MerkleProof } from "../../../src/types/MerkleService.js";
```

Each subfolder (`types/`, `errors/`, `services/`, `schemas/`, etc.) has its own `index.ts` that re-exports everything. That `index.ts` is then re-exported from `internal.ts`.

---

## 2. Class Method Ordering

**When:** adding or reorganizing methods in a class.

Methods MUST follow a **top-down, caller-before-callee** layout:

1. Static factory methods (if any)
2. Constructor
3. **All public methods** (the class's external API)
4. **All private methods** below, ordered so caller appears before callee

```ts
// GOOD
class ExampleService {
    static create() { ... }             // 1st — static factory
    constructor(config: Config) { ... }  // 2nd — constructor
    publicA() { this.helperB(); }        // 3rd — public
    publicC() { this.helperD(); }        // 4th — public
    private helperB() { ... }            // 5th — private, called by publicA
    private helperD() { ... }            // 6th — private, called by publicC
}

// BAD — private method above public method
class ExampleService {
    private helperB() { ... }            // WRONG: private before public
    publicA() { this.helperB(); }
}
```

---

## 3. Dependency Injection via Config Object

**When:** writing a constructor or adding a new dependency to a service.

Constructor dependencies MUST be passed through a typed config object — NEVER as loose parameters. A class may accept **at most two** config objects:

1. **Primary config** — core dependencies
2. **Secondary config** *(optional)* — auxiliary dependencies (e.g., Logger)

```ts
// GOOD
type MerkleServiceConfig = { hashService: IHashService };
class MerkleService {
    constructor(config: MerkleServiceConfig) { ... }
}

// BAD — loose parameter
class LocalCircuitArtifacts {
    constructor(baseDir: string) { ... }  // WRONG: should be a config object
}
```

Define config types in `src/types/`, import via `internal.js`.

---

## 4. JSDoc Exception Documentation

**When:** documenting a service interface or its implementation.

This follows a strict two-layer pattern. Use `@inheritdoc` (lowercase `d`), NEVER `{@inheritDoc}` (uppercase).

### Interface (`interfaces/I<Service>.ts`)

- The interface is the single source of truth for params, returns, and description.
- `@throws` MUST reference ONLY the **base error** — NEVER list specific subclasses.

```ts
// GOOD — interface uses base error only
/**
 * Inserts a new note.
 * @param note - The note to add.
 * @throws {NoteManagerBaseError}
 */
addNote(note: Note): void;

// BAD — interface lists specific errors (these belong in the implementation)
/**
 * @throws {NoteNotFoundError} If note not found.
 * @throws {InvalidNoteError} If note is invalid.
 */
addNote(note: Note): void;
```

### Implementation (`services/<Service>.ts`)

- Use `@inheritdoc I<Service>.<method>` to inherit JSDoc — NEVER duplicate the full description.
- Below `@inheritdoc`, add one `@throws` for **each specific exception** the method throws.

```ts
// GOOD — implementation inherits + lists specifics
/**
 * @inheritdoc INoteManager.addNote
 * @throws {InvalidNoteError} If the note fails schema validation.
 */
addNote(note: Note): void { ... }

// BAD — missing specific @throws in implementation
/**
 * @inheritdoc INoteManager.addNote
 */
addNote(note: Note): void { ... }  // WRONG: method throws but @throws not documented
```

---

## 5. Hex as the External Data Format

**When:** defining public method signatures (params and return types).

All values that **enter or leave** a service MUST be `Hex` (`0x`-prefixed hex string). Internal byte conversions are fine, but the public API surface always speaks Hex.

```ts
// GOOD
getBlockNumber(): Promise<Hex>;
hash(inputs: Hex[]): Promise<Hex>;

// BAD — raw types in public API
getBlockNumber(): Promise<number>;
hash(inputs: Uint8Array[]): Promise<bigint>;
```

---

## 6. Test Naming

**When:** writing `it()` or `test()` descriptions.

Test names MUST describe behavior starting with a verb. NEVER start with "should".

```ts
// GOOD
it("compute correct shared secret for test vector 1", ...);
it("reject uncompressed public key with InvalidPublicKey error", ...);
it("throw InvalidRpcUrl for an empty string", ...);

// BAD
it("should compute correct shared secret", ...);
it("should reject uncompressed public key", ...);
```
