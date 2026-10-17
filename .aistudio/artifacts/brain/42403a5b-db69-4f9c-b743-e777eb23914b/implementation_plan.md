# Phase 1 Implementation Plan: Authentication, Persistence & Exam History (Revised)

A safe, comprehensive blueprint to introduce teacher authentication, guest isolation, persistent SQLite storage, and an interactive exam history UI into the active Node.js / Express / TypeScript backend (`server.ts`) while preserving all existing pink UI designs, document parsing, question editing, and export workflows.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural decisions have been revised based on your requirements and verified against the runtime environment:

1. **Verified Persistence Engine: Node.js 22 Built-in SQLite (`node:sqlite`)**:
   - **Environment Verification Result:** Verified in the active runtime running **Node.js v22.23.2**. `import { DatabaseSync } from 'node:sqlite'` and `npx tsx` execute natively with zero errors, zero npm dependencies, and zero C++ native compilation risk.
   - **Storage File:** `data/examcraft.db` with WAL mode enabled (`PRAGMA journal_mode = WAL;`) for concurrent read performance and ACID crash resilience.

2. **Explicit Consent for Guest Data Migration**:
   - Guest data is **never migrated silently or automatically** upon registration.
   - When a guest chooses to register a teacher account, the registration form presents an explicit opt-in checkbox:
     `[x] Import my current guest exam and documents into my new account` (default: checked, can be unchecked).
   - If unchecked, the user starts with a clean account and the guest session remains completely isolated. If checked, an explicit transfer transaction reassigns the guest records to the new `user_id`.

3. **Token Expiration & Logout Security**:
   - **HMAC-SHA256 Token Structure:** Cryptographically signed using `SECRET_KEY`, containing `userId`, `role`, `issuedAt`, `expiresAt` (default TTL: 7 days), and `tokenVersion`.
   - **Revocation & Logout Security:** When a user logs out, the client purges all stored tokens from `localStorage` and memory. In addition, the backend increments `token_version` on the user record in SQLite, instantly invalidating any previously issued tokens even if intercepted.

4. **Safe Backup & Migration Strategy**:
   - Before applying schema migrations or booting the database, an automated backup routine creates a timestamped copy of `data/examcraft.db` in `data/backups/examcraft_backup_<timestamp>.db` (retaining the last 5 rotating backups).
   - Database migrations use a versioned table (`_schema_migrations`) ensuring idempotency across server restarts.

5. **Deferred Items**:
   - Print Sheet functionality remains strictly untouched and deferred until the final phase as instructed.

---

## 1. Overview & Core Concept

- **What It Delivers**:
  1. **Teacher Accounts & Authentication**: Secure registration, login, logout, and token-based authentication with `node:crypto.scryptSync` password hashing and email validation.
  2. **Guest Mode & Isolation**: Zero-friction guest access generating isolated guest session identifiers (`guest_<uuid>`), ensuring visitors can test the platform without seeing other guests' data.
  3. **Explicit Data Migration**: Clear opt-in consent for transferring guest documents and exams into a newly created permanent teacher account.
  4. **Durable SQLite Persistence**: Replacement of ephemeral in-memory variables in `server.ts` with a durable SQLite relational database (`data/examcraft.db`) that survives server restarts.
  5. **Interactive Exam History UI**: A drawer/modal allowing educators to browse saved exams, view question totals, trigger PDF/DOCX downloads, and switch active exams on demand.
- **Target Persona**: Secondary and university educators generating, reviewing, and organizing multi-group examinations.
- **Key Value**: Guarantees zero loss of generated exams or uploaded documents across server reboots, isolates multi-user data, and provides clear session control.

---

## 2. User Experience & Visual Design

### Key User Flows

```
┌────────────────────────────────────────────────────────────────────────┐
│ Top Navigation Bar (src/App.tsx)                                       │
│ [E ExamCraft AI]   [Exam History (3)]   [LLM Key: OK]   [Prof. Harris ▼]│
└────────────────────────────────────────────────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
┌───────────────────────────────┐   ┌───────────────────────────────┐
│ Sign In / Register Modal      │   │ Exam History Modal            │
│ ┌─────────────┬─────────────┐ │   │ • Cell Bio Midterm (3 Grps)   │
│ │   Sign In   │   Register  │ │   │   [Open & Edit]  [PDF] [DOCX] │
│ └─────────────┴─────────────┘ │   │ • Genetics Final (3 Grps)     │
│ [Email Input                ] │   │   [Open & Edit]  [PDF] [DOCX] │
│ [Password Input             ] │   │ ───────────────────────────── │
│ [x] Import current guest exam │   │ [+ Create Brand New Exam]     │
│ [Create Teacher Account     ] │   └───────────────────────────────┘
│ or [Continue as Guest Mode]   │
└───────────────────────────────┘
```

1. **Authentication & Explicit Consent Flow**:
   - Navigation header displays user status pill: `Guest Mode (Temporary)` or `Teacher Name (Institution)`.
   - Clicking `Sign In` opens the modal matching the existing brand aesthetic.
   - In **Register** view, if the visitor has generated an exam in guest mode, an explicit prompt appears:
     *"Import your current guest exam and documents into your new account?"* with a checkbox.
   - If unchecked, the guest data is left separate and the registered account starts fresh.
2. **Logout Flow**:
   - User clicks `Logout` in the user menu.
   - Backend invalidates active tokens via `token_version` bump. Client clears stored credentials and initializes a fresh, isolated guest session.
3. **Exam History Flow**:
   - Clicking `Exam History` opens the modal showing all exams owned by the authenticated teacher or active guest session.
   - Each card displays title, subject, creation date, groups count, total questions, and total marks.
   - Actions: `Open in Editor` (sets active exam in workspace), `Export DOCX`, `Export PDF`, and `Delete Exam`.
   - Clicking `+ Create New Exam` resets the workspace to Step 1 without removing saved exams.

### Visual Identity & Theme
- **Primary Color:** `#9D174D` (Deep crimson pink) for buttons, badges, and primary accents.
- **Hover States:** `#83133E` for interactive hover feedback.
- **Background Atmosphere:** `#FAF9F6` (light warm cream) with crisp white cards (`bg-white`), borders (`border-stone-200`), and soft pink accents (`pink-50`, `pink-100`, `rose-50`).
- **Typography:** `Plus Jakarta Sans` with `Vazirmatn` for RTL script support. Zero changes to existing layout structure.

---

## 3. Technical Architecture & Data Strategy

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                               REACT FRONTEND                                 │
│  src/App.tsx (Header Auth Status, History Trigger, LLM Settings Trigger)     │
│  ├── src/components/AuthModal.tsx (Sign In, Register with Consent Checkbox)  │
│  ├── src/components/ExamHistoryModal.tsx (Exam Switcher & Quick Export)      │
│  ├── src/components/ExamWorkspace.tsx (Step 1 -> Step 2 -> Step 3)          │
│  └── src/components/AcademicPaperPreview.tsx (Student Paper & Answer Key)    │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ HTTP Bearer / Guest Session Header
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           EXPRESS BACKEND (server.ts)                        │
│  Auth Middleware: authenticateUserOrGuest (Validates Token & token_version)  │
│  ├── Auth Routes: /api/auth/register, /api/auth/login, /api/auth/logout, /me │
│  ├── Exam Routes: /api/exams (Scoped to user_id | session_id)                │
│  ├── Document Routes: /api/documents (Scoped to user_id | session_id)        │
│  └── Export Engine: DOCX & PDF Streams                                       │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ Prepared SQL Statements (ACID)
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                    SQLITE PERSISTENCE (data/examcraft.db)                    │
│  Tables: users, sessions, documents, chunks, exams, groups, questions        │
│  Auto-Backup: data/backups/examcraft_backup_<timestamp>.db                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Relational Schema Design (`data/examcraft.db`)

1. **`users`**:
   - `id` (TEXT PRIMARY KEY), `email` (TEXT UNIQUE), `password_hash` (TEXT), `salt` (TEXT), `full_name` (TEXT), `institution` (TEXT), `role` (TEXT), `token_version` (INTEGER DEFAULT 1), `created_at` (TEXT), `updated_at` (TEXT).
2. **`documents`**:
   - `id` (TEXT PRIMARY KEY), `user_id` (TEXT REFERENCES users), `session_id` (TEXT), `filename` (TEXT), `file_type` (TEXT), `file_size_bytes` (INTEGER), `detected_language` (TEXT), `is_rtl` (INTEGER), `total_pages` (INTEGER), `status` (TEXT), `metadata_json` (TEXT), `created_at` (TEXT).
3. **`document_chunks`**:
   - `id` (TEXT PRIMARY KEY), `document_id` (TEXT REFERENCES documents ON DELETE CASCADE), `page_number` (INTEGER), `chapter` (TEXT), `section` (TEXT), `content` (TEXT), `token_count` (INTEGER), `chunk_index` (INTEGER).
4. **`exams`**:
   - `id` (TEXT PRIMARY KEY), `user_id` (TEXT REFERENCES users), `session_id` (TEXT), `document_id` (TEXT), `title` (TEXT), `subject` (TEXT), `institution` (TEXT), `teacher_name` (TEXT), `grade_level` (TEXT), `exam_date` (TEXT), `duration_minutes` (INTEGER), `total_marks` (REAL), `language` (TEXT), `is_rtl` (INTEGER), `bloom_enabled` (INTEGER), `status` (TEXT), `groups_count` (INTEGER), `questions_count` (INTEGER), `difficulty_distribution_json` (TEXT), `question_types_config_json` (TEXT), `created_at` (TEXT), `updated_at` (TEXT).
5. **`exam_groups`**:
   - `id` (TEXT PRIMARY KEY), `exam_id` (TEXT REFERENCES exams ON DELETE CASCADE), `group_name` (TEXT), `group_order` (INTEGER), `questions_count` (INTEGER).
6. **`exam_questions`**:
   - `id` (TEXT PRIMARY KEY), `exam_id` (TEXT REFERENCES exams ON DELETE CASCADE), `group_id` (TEXT REFERENCES exam_groups ON DELETE CASCADE), `question_order` (INTEGER), `question_type` (TEXT), `question_text` (TEXT), `options_json` (TEXT), `correct_answer` (TEXT), `explanation` (TEXT), `marks` (REAL), `difficulty` (TEXT), `bloom_level` (TEXT), `source_document_name` (TEXT), `source_page` (INTEGER), `source_chapter` (TEXT), `source_section` (TEXT), `source_chunk_id` (TEXT), `source_evidence` (TEXT), `created_at` (TEXT), `updated_at` (TEXT).

---

## 4. Exact Files to Create or Modify

### New Files to Create
1. `src/server/db.ts` — SQLite initialization using `node:sqlite`, automatic backup runner, schema migrations, and repository queries for users, documents, and exams.
2. `src/server/auth.ts` — `scryptSync` password hashing/verification, HMAC-SHA256 token issuance/verification with `token_version` checks, and Express authentication middleware.
3. `src/components/AuthModal.tsx` — Teacher sign-in and registration modal with explicit guest data import opt-in and guest mode switcher.
4. `src/components/ExamHistoryModal.tsx` — Exam history viewer, switcher, quick export buttons, and deletion confirmation modal.
5. `scripts/test_phase1_auth_persistence.js` — Automated test suite verifying registration, login, logout invalidation, guest isolation, explicit consent transfer, persistence across restarts, and regression safety.

### Existing Files to Modify
1. `server.ts` — Wire `db.ts` and `auth.ts`, add `/api/auth/*` endpoints, scope document and exam routes by `user_id` or `session_id`, and replace in-memory arrays.
2. `src/App.tsx` — Add user status pill, auth triggers, logout flow, and Exam History modal toggle.
3. `src/components/ExamWorkspace.tsx` — Pass auth tokens on API calls, add "Create New Exam" reset trigger, and add "View Exam History" shortcut.
4. `.env.example` — Document `SECRET_KEY` configuration.

---

## 5. Numbered Implementation Sequence & Acceptance Criteria

### Step 1: Database Initialization & Safe Backup Engine (`src/server/db.ts`)
- **Actions**:
  - Implement startup backup routine copying `data/examcraft.db` to `data/backups/examcraft_backup_<timestamp>.db`.
  - Initialize SQLite with `DatabaseSync` from `node:sqlite` in WAL mode.
  - Apply idempotent relational schema.
  - Seed initial Cell Biology exam only when database has 0 exams.
- **Acceptance Criteria**:
  - `data/examcraft.db` and backup directory are created cleanly.
  - Data persists across server restarts.

### Step 2: Authentication Engine & Token Security (`src/server/auth.ts`)
- **Actions**:
  - Implement password hashing with 16-byte random salts via `node:crypto.scryptSync`.
  - Implement HMAC-SHA256 token creation and validation with 7-day TTL and `tokenVersion` check.
  - Implement `authenticateUserOrGuest` Express middleware supporting both registered teacher tokens and `guest_<uuid>` session IDs.
- **Acceptance Criteria**:
  - Invalid, expired, or tampered tokens return HTTP 401.
  - Bumping `token_version` immediately revokes active tokens.

### Step 3: Express Backend Route Integration (`server.ts`)
- **Actions**:
  - Add `/api/auth/register` (with optional `import_guest_session_id`), `/api/auth/login`, `/api/auth/logout`, and `/api/auth/me`.
  - When `import_guest_session_id` is supplied with explicit consent, reassign matching guest documents and exams to the new `user_id` in a single ACID transaction.
  - Enforce ownership filtering on `/api/documents`, `/api/exams`, question edit, and question delete.
- **Acceptance Criteria**:
  - User A cannot access User B's documents or exams (HTTP 403/404).
  - Guest sessions remain strictly isolated.

### Step 4: Frontend Authentication UI & Consent Checkbox (`src/components/AuthModal.tsx` & `src/App.tsx`)
- **Actions**:
  - Create `AuthModal.tsx` styled with the existing pink palette.
  - Include the explicit opt-in checkbox for guest exam migration upon registration.
  - Manage auth state in `App.tsx` and provide logout button that revokes backend session and resets client storage.
- **Acceptance Criteria**:
  - Registration without consent leaves guest data isolated.
  - Registration with consent transfers the active guest exam to the teacher account.
  - Logout cleanly switches to a fresh guest session.

### Step 5: Exam History & Switcher UI (`src/components/ExamHistoryModal.tsx`)
- **Actions**:
  - Build `ExamHistoryModal.tsx` listing user/guest saved exams with details and quick export triggers.
  - Provide "Open in Editor" to switch active exam in workspace.
  - Provide "+ Create New Exam" button to start a fresh exam without deleting history.
- **Acceptance Criteria**:
  - All saved exams display accurately with question counts and marks.
  - Switching exams updates the workspace instantly.

### Step 6: Automated Testing & Verification
- **Actions**:
  - Run `scripts/test_phase1_auth_persistence.js` covering:
    1. Registration & login authentication flow.
    2. Token expiration and logout revocation.
    3. Guest isolation and explicit consent migration.
    4. SQLite data persistence across simulated server restarts.
    5. Regression checks for question editing, deletion, and exports.
- **Acceptance Criteria**:
  - 100% test assertions pass.
  - Typecheck (`npm run lint`) and compilation succeed without errors.

---

## 6. Security Safeguards & Verification Summary

- **Node.js Compatibility:** Verified running Node.js `22.23.2` with native `node:sqlite` `DatabaseSync`.
- **Password Security:** `scryptSync` with 16-byte random salts.
- **Token Security:** HMAC-SHA256 signature with `SECRET_KEY`, 7-day TTL, and instant server-side revocation on logout via `token_version`.
- **SQL Injection Prevention:** 100% prepared statements with parameterized inputs.
- **Data Safety:** Automatic rolling backups in `data/backups/` on startup.
