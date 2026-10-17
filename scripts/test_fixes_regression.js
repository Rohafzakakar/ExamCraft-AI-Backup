import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'http://localhost:3000';

async function runRegressionTests() {
  console.log('\n======================================================');
  console.log('  EXAMCRAFT AI: REGRESSION & SPECIFIC FIXES TEST SUITE ');
  console.log('======================================================\n');

  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      console.error(`  [FAIL] ${name}:`, err.message);
      throw err;
    }
  }

  // 1. Verify existing SQLite data and backup preservation
  await test('Existing SQLite data and backup directory are preserved', async () => {
    const dbPath = path.resolve(process.cwd(), 'data', 'examcraft.db');
    const backupDir = path.resolve(process.cwd(), 'data', 'backups');
    assert(fs.existsSync(dbPath), 'data/examcraft.db must exist');
    assert(fs.existsSync(backupDir), 'data/backups must exist');

    const backupFiles = fs.readdirSync(backupDir);
    assert(backupFiles.length > 0, 'data/backups must contain backed-up files');
  });

  // 2. Generate exam containing Unicode characters: ➢ (0x27a2), Dari/Persian, Arabic, bullets, quotes, dashes
  let unicodeExamId = '';
  await test('Create exam containing ➢ (0x27a2) and Dari/Persian Unicode text', async () => {
    // Generate base exam under a unique guest session
    const guestId = `guest_unicode_test_${Date.now()}`;
    const genRes = await fetch(`${BASE_URL}/api/exams/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guestId}`,
      },
      body: JSON.stringify({
        document_id: 'doc-cell-biology-101',
        title: 'امتحان بیولوژی (Cell Biology Examination ➢ Spring 2026)',
        subject: 'زیست‌شناسی و ژنتیک (Genetics)',
        groups_count: 2,
        question_types_config: { mcq: 2, true_false: 1 },
      }),
    });

    assert.strictEqual(genRes.status, 201, 'Exam generation must succeed');
    const examData = await genRes.json();
    unicodeExamId = examData.id;

    // Edit Question 1 in Group A to include the exact failing character "➢" (0x27a2)
    // as well as Dari/Persian script, smart quotes, bullets, and em-dash
    const q1 = examData.groups[0].questions[0];
    const updateRes = await fetch(`${BASE_URL}/api/exams/${unicodeExamId}/questions/${q1.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guestId}`,
      },
      body: JSON.stringify({
        question_text: 'سوال ۱: ➢ وظیفه اصلی میتوکندری در سلول چیست؟ • “انرژی‌سازی” — توضیح دهید.',
        correct_answer: '➢ تولید مولکول‌های ATP از طریق فسفوریلاسیون اکسیداتیو',
        explanation: '➢ میتوکندری نیروگاه سلول است (Mitochondria produce cellular ATP).',
        options: [
          'الف) ➢ تولید ATP و تنفس هوازی',
          'ب) ➢ سنتز زنجیره پلی‌پپتیدی',
          'ج) ➢ همانندسازی DNA هسته‌ای',
          'د) ➢ هضم آنزیمی لیپیدها',
        ],
      }),
    });

    assert.strictEqual(updateRes.status, 200, 'Updating question with Unicode must succeed');
  });

  // 3. Export PDF with Unicode and ➢ (0x27a2) - Must not throw WinAnsi cannot encode
  await test('PDF export succeeds without WinAnsi encoding errors on ➢ and Persian/Dari text', async () => {
    const res = await fetch(`${BASE_URL}/api/exams/${unicodeExamId}/export/pdf?target=both`);
    assert.strictEqual(res.status, 200, `PDF export must return 200 OK, got ${res.status}`);
    assert.strictEqual(res.headers.get('content-type'), 'application/pdf');

    const buffer = Buffer.from(await res.arrayBuffer());
    assert(buffer.length > 2000, `PDF buffer length must be > 2000 bytes, got ${buffer.length}`);

    // Verify valid PDF header signature
    const header = buffer.subarray(0, 5).toString('ascii');
    assert.strictEqual(header, '%PDF-', 'Buffer must start with %PDF-');

    // Verify valid PDF EOF signature near end of file
    const tail = buffer.subarray(buffer.length - 128).toString('latin1');
    assert(tail.includes('%%EOF'), 'Buffer must conclude with valid %%EOF marker');
  });

  // 4. Test PDF export for exam paper only and answer key only modes
  await test('PDF export for target=exam and target=answer_key modes succeed', async () => {
    const resExam = await fetch(`${BASE_URL}/api/exams/${unicodeExamId}/export/pdf?target=exam`);
    assert.strictEqual(resExam.status, 200);
    const bufExam = Buffer.from(await resExam.arrayBuffer());
    assert(bufExam.length > 1000);

    const resKey = await fetch(`${BASE_URL}/api/exams/${unicodeExamId}/export/pdf?target=answer_key`);
    assert.strictEqual(resKey.status, 200);
    const bufKey = Buffer.from(await resKey.arrayBuffer());
    assert(bufKey.length > 1000);
  });

  // 5. Test DOCX export with Unicode characters remains functional
  await test('DOCX export stream handles Unicode ➢ and Dari/Persian characters cleanly', async () => {
    const res = await fetch(`${BASE_URL}/api/exams/${unicodeExamId}/export/docx?target=both`);
    assert.strictEqual(res.status, 200);
    assert(res.headers.get('content-type').includes('openxmlformats'));

    const buffer = Buffer.from(await res.arrayBuffer());
    assert(buffer.length > 2000, 'DOCX file must have valid non-empty byte stream');

    // Check standard ZIP signature (PK..) for docx
    assert.strictEqual(buffer[0], 0x50, 'DOCX must be valid PK zip format (byte 0 = 0x50)');
    assert.strictEqual(buffer[1], 0x4b, 'DOCX must be valid PK zip format (byte 1 = 0x4B)');
  });

  // 6. Test Frontend Entry point serves cleanly with 200 OK
  await test('Vite dev server middleware serves index.html and SPA assets with 200 OK', async () => {
    const res = await fetch(`${BASE_URL}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert(html.includes('<title>ExamCraft AI'), 'index.html must include ExamCraft title');
    assert(html.includes('src/main.tsx'), 'index.html must include main.tsx script entry');
  });

  // 7. Verify AuthModal form state invariants in source
  await test('AuthModal source enforces unchecked consent and clean state transitions', async () => {
    const authModalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'AuthModal.tsx'), 'utf8');

    // 1. Consent checkbox default is false
    assert(
      authModalSrc.includes('useState(false)'),
      'consentImportGuest must default to false (unchecked)'
    );

    // 2. Passwords wiped on tab switch
    assert(
      authModalSrc.includes("setPassword('')"),
      'setPassword must be cleared on transitions and closes'
    );

    // 3. Listens to auth reset events
    assert(
      authModalSrc.includes('examcraft_auth_changed'),
      'AuthModal must listen to auth changes to wipe stale state on logout'
    );
  });

  console.log('\n======================================================');
  console.log(`  ALL ${passed} / ${total} REGRESSION & FIX TESTS PASSED! `);
  console.log('======================================================\n');
}

runRegressionTests().catch((err) => {
  console.error('\nRegression test failed:', err);
  process.exit(1);
});
