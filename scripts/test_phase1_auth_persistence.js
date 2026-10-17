import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'http://localhost:3000';

async function runTests() {
  console.log('\n======================================================');
  console.log('  EXAMCRAFT AI: PHASE 1 COMPREHENSIVE VERIFICATION  ');
  console.log('======================================================\n');

  let passed = 0;
  let total = 0;

  function test(description, fn) {
    total++;
    try {
      fn();
      passed++;
      console.log(`  [PASS] ${description}`);
    } catch (err) {
      console.error(`  [FAIL] ${description}:`, err.message);
      throw err;
    }
  }

  async function asyncTest(description, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`  [PASS] ${description}`);
    } catch (err) {
      console.error(`  [FAIL] ${description}:`, err.message);
      throw err;
    }
  }

  // 1. Health check
  await asyncTest('Backend health endpoint returns 200 OK', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'healthy');
  });

  // 2. Database and backup directory existence
  test('SQLite database and backup directory exist on disk', () => {
    const dbPath = path.resolve(process.cwd(), 'data', 'examcraft.db');
    const backupDir = path.resolve(process.cwd(), 'data', 'backups');
    assert(fs.existsSync(dbPath), 'data/examcraft.db must exist');
    assert(fs.existsSync(backupDir), 'data/backups must exist');
  });

  // 3. User registration validation
  await asyncTest('Registration rejects invalid email or short password', async () => {
    const res1 = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: '123' }),
    });
    assert.strictEqual(res1.status, 400);

    const res2 = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'valid@school.edu', password: '123' }),
    });
    assert.strictEqual(res2.status, 400);
  });

  // 4. Successful Teacher Registration
  const testEmail = `teacher_${Date.now()}@university.edu`;
  const testPassword = 'SecurePassword2026!';
  let teacherToken = '';
  let teacherUserId = '';

  await asyncTest('Teacher registration succeeds with token and user object', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
        full_name: 'Dr. Jane Harrison',
        institution: 'Faculty of Cellular Biology',
      }),
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert(data.token, 'Token must be returned');
    assert.strictEqual(data.user.email, testEmail);
    assert.strictEqual(data.user.full_name, 'Dr. Jane Harrison');
    assert.strictEqual(data.user.institution, 'Faculty of Cellular Biology');
    teacherToken = data.token;
    teacherUserId = data.user.id;
  });

  // 5. Duplicate Email Rejection
  await asyncTest('Registration rejects duplicate email with 409 Conflict', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
        full_name: 'Duplicate Teacher',
      }),
    });
    assert.strictEqual(res.status, 409);
  });

  // 6. Login Validation
  await asyncTest('Login rejects incorrect password with 401 Unauthorized', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: 'WrongPassword!' }),
    });
    assert.strictEqual(res.status, 401);
  });

  await asyncTest('Login succeeds with correct credentials and returns token', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert(data.token, 'Token must be returned on login');
    assert.strictEqual(data.user.id, teacherUserId);
    teacherToken = data.token;
  });

  // 7. Protected Route /api/auth/me
  await asyncTest('/api/auth/me returns authenticated teacher info with Bearer token', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.authenticated, true);
    assert.strictEqual(data.is_guest, false);
    assert.strictEqual(data.user.id, teacherUserId);
  });

  // 8. Guest Isolation: Guest 1 vs Guest 2
  const guest1Id = `guest_test_isolation_1_${Date.now()}`;
  const guest2Id = `guest_test_isolation_2_${Date.now()}`;

  await asyncTest('Guest 1 and Guest 2 sessions have isolated views', async () => {
    // Generate an exam under Guest 1
    const genRes = await fetch(`${BASE_URL}/api/exams/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guest1Id}`,
      },
      body: JSON.stringify({
        document_id: 'doc-cell-biology-101',
        title: 'Guest 1 Private Exam',
        subject: 'Microbiology',
        groups_count: 2,
        question_types_config: { mcq: 2, true_false: 1 },
      }),
    });
    assert.strictEqual(genRes.status, 201);
    const guest1Exam = await genRes.json();

    // Query exams under Guest 1
    const g1ListRes = await fetch(`${BASE_URL}/api/exams`, {
      headers: { Authorization: `Bearer ${guest1Id}` },
    });
    const g1Exams = await g1ListRes.json();
    assert(g1Exams.some((e) => e.id === guest1Exam.id), 'Guest 1 should see their own exam');

    // Query exams under Guest 2
    const g2ListRes = await fetch(`${BASE_URL}/api/exams`, {
      headers: { Authorization: `Bearer ${guest2Id}` },
    });
    const g2Exams = await g2ListRes.json();
    assert(!g2Exams.some((e) => e.id === guest1Exam.id), 'Guest 2 must NOT see Guest 1 private exam');

    // Guest 2 trying to access Guest 1 exam directly gets 404
    const directRes = await fetch(`${BASE_URL}/api/exams/${guest1Exam.id}`, {
      headers: { Authorization: `Bearer ${guest2Id}` },
    });
    assert.strictEqual(directRes.status, 404);
  });

  // 9. Explicit Consent for Guest Migration
  const migratingGuestId = `guest_migrate_${Date.now()}`;
  let guestMigratedExamId = '';

  await asyncTest('Explicit consent migrates guest data to new teacher account', async () => {
    // Create an exam under migrating guest
    const genRes = await fetch(`${BASE_URL}/api/exams/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${migratingGuestId}`,
      },
      body: JSON.stringify({
        document_id: 'doc-cell-biology-101',
        title: 'Transferred Guest Exam',
        subject: 'Genetics',
        groups_count: 2,
        question_types_config: { mcq: 2 },
      }),
    });
    assert.strictEqual(genRes.status, 201);
    const guestExam = await genRes.json();
    guestMigratedExamId = guestExam.id;

    // Register with consent_import_guest = true
    const regEmail = `transferred_${Date.now()}@school.edu`;
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: regEmail,
        password: 'Password123!',
        full_name: 'Prof. Transfer',
        institution: 'Genetics Institute',
        import_guest_session_id: migratingGuestId,
        consent_import_guest: true,
      }),
    });
    assert.strictEqual(regRes.status, 201);
    const regData = await regRes.json();
    assert(regData.guest_migration.transferredExams >= 1, 'Transferred exam count must be >= 1');

    // Verify teacher now owns the exam
    const teacherExamsRes = await fetch(`${BASE_URL}/api/exams`, {
      headers: { Authorization: `Bearer ${regData.token}` },
    });
    const teacherExams = await teacherExamsRes.json();
    assert(teacherExams.some((e) => e.id === guestMigratedExamId), 'Teacher must now own the migrated exam');
  });

  // 10. Refusing Consent Leaves Guest Data Isolated
  const nonMigratingGuestId = `guest_no_migrate_${Date.now()}`;
  let nonMigratedExamId = '';

  await asyncTest('Refusing consent does NOT migrate guest data to new teacher account', async () => {
    const genRes = await fetch(`${BASE_URL}/api/exams/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${nonMigratingGuestId}`,
      },
      body: JSON.stringify({
        document_id: 'doc-cell-biology-101',
        title: 'Separate Guest Exam',
        subject: 'Biochemistry',
        groups_count: 2,
        question_types_config: { mcq: 2 },
      }),
    });
    assert.strictEqual(genRes.status, 201);
    const guestExam = await genRes.json();
    nonMigratedExamId = guestExam.id;

    // Register with consent_import_guest = false
    const regEmail = `clean_${Date.now()}@school.edu`;
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: regEmail,
        password: 'Password123!',
        full_name: 'Prof. Clean',
        import_guest_session_id: nonMigratingGuestId,
        consent_import_guest: false,
      }),
    });
    assert.strictEqual(regRes.status, 201);
    const regData = await regRes.json();
    assert.strictEqual(regData.guest_migration.transferredExams, 0, 'No exams should transfer without consent');

    // Verify teacher does NOT have the exam
    const teacherExamsRes = await fetch(`${BASE_URL}/api/exams`, {
      headers: { Authorization: `Bearer ${regData.token}` },
    });
    const teacherExams = await teacherExamsRes.json();
    assert(!teacherExams.some((e) => e.id === nonMigratedExamId), 'Teacher must NOT have the separate guest exam');
  });

  // 11. Token Revocation on Logout
  await asyncTest('Logout revokes token immediately on server via token_version bump', async () => {
    // Logout with teacherToken
    const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.strictEqual(logoutRes.status, 200);

    // Using old teacherToken on /api/auth/me should now return is_guest = true (token invalid)
    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    const meData = await meRes.json();
    assert.strictEqual(meData.authenticated, false, 'Revoked token must not authenticate user');
  });

  // 12. Regression: MCQ Question Editing in SQLite
  await asyncTest('Editing question synchronizes updates into SQLite database', async () => {
    const seedExamRes = await fetch(`${BASE_URL}/api/exams/exam-cell-bio-midterm`);
    assert.strictEqual(seedExamRes.status, 200);
    const seedExam = await seedExamRes.json();
    const q1 = seedExam.groups[0].questions[0];

    const editRes = await fetch(`${BASE_URL}/api/exams/${seedExam.id}/questions/${q1.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question_text: 'Updated Question: Which organelle houses eukaryotic chromosomes?',
        marks: 3.5,
        options: ['Chromatin Nucleus', 'Mitochondria Matrix', 'Golgi Stack', 'Ribosome'],
        correct_answer: 'Chromatin Nucleus',
        explanation: 'Verified chromosome housing.',
      }),
    });
    assert.strictEqual(editRes.status, 200);
    const editedQ = await editRes.json();
    assert.strictEqual(editedQ.marks, 3.5);

    // Verify persisted in fresh fetch
    const freshRes = await fetch(`${BASE_URL}/api/exams/${seedExam.id}`);
    const freshExam = await freshRes.json();
    const freshQ = freshExam.groups[0].questions[0];
    assert.strictEqual(freshQ.marks, 3.5);
    assert.strictEqual(freshQ.question_text, 'Updated Question: Which organelle houses eukaryotic chromosomes?');
  });

  // 13. Regression: Question Deletion in SQLite
  await asyncTest('Deleting question updates counts and total marks across groups in SQLite', async () => {
    // Create an exam with 4 questions to safely delete one
    const genRes = await fetch(`${BASE_URL}/api/exams/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document_id: 'doc-cell-biology-101',
        title: 'Delete Test Exam',
        groups_count: 2,
        question_types_config: { mcq: 2, true_false: 1, short_answer: 1 },
      }),
    });
    assert.strictEqual(genRes.status, 201);
    const exam = await genRes.json();
    const targetQ = exam.groups[0].questions[0];
    const initialMarks = exam.total_marks;

    const delRes = await fetch(`${BASE_URL}/api/exams/${exam.id}/questions/${targetQ.id}`, {
      method: 'DELETE',
    });
    assert.strictEqual(delRes.status, 200);
    const delData = await delRes.json();
    assert(delData.deleted_count >= 1);
    assert(delData.new_total_marks < initialMarks);

    // Verify in database
    const freshRes = await fetch(`${BASE_URL}/api/exams/${exam.id}`);
    const freshExam = await freshRes.json();
    assert.strictEqual(freshExam.groups[0].questions.length, exam.groups[0].questions.length - 1);
  });

  // 14. Regression: Answer Keys
  await asyncTest('Answer keys endpoint returns all group answer items', async () => {
    const res = await fetch(`${BASE_URL}/api/exams/exam-cell-bio-midterm/answer-key`);
    assert.strictEqual(res.status, 200);
    const keys = await res.json();
    assert(Array.isArray(keys));
    assert(keys.length >= 1);
    assert(keys[0].items.length >= 1);
    assert(keys[0].items[0].correct_answer);
  });

  // 15. Regression: DOCX Export
  await asyncTest('DOCX export stream returns application/vnd.openxmlformats', async () => {
    const res = await fetch(`${BASE_URL}/api/exams/exam-cell-bio-midterm/export/docx?target=both`);
    assert.strictEqual(res.status, 200);
    assert(res.headers.get('content-type').includes('openxmlformats'));
    const buffer = await res.arrayBuffer();
    assert(buffer.byteLength > 1000, 'DOCX stream must contain valid file bytes');
  });

  // 16. Regression: PDF Export
  await asyncTest('PDF export stream returns application/pdf', async () => {
    const res = await fetch(`${BASE_URL}/api/exams/exam-cell-bio-midterm/export/pdf?target=both`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
    const buffer = await res.arrayBuffer();
    assert(buffer.byteLength > 1000, 'PDF stream must contain valid file bytes');
  });

  console.log('\n======================================================');
  console.log(`  ALL ${passed} / ${total} TESTS PASSED CLEANLY! `);
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('\nTest suite failed with error:', err);
  process.exit(1);
});
