import assert from 'node:assert';
import http from 'node:http';
import { areQuestionsDuplicate, normalizeQuestionText, normalizeQuestionOptions } from '../src/server/duplicateDetector.js';

const PORT = process.env.PORT || 8080;
const BASE_URL = `http://localhost:${PORT}`;

function httpPostJson(url, data, token) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        } catch {
          resolve({ statusCode: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function httpGet(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          buffer: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runLiveVerification() {
  console.log('\n======================================================');
  console.log('  EXAMCRAFT AI: REAL END-TO-END GENERATION VERIFICATION');
  console.log('======================================================\n');

  let passed = 0;
  let total = 0;

  async function check(name, fn) {
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

  let generatedExamId = '';

  // 1. Generate exam on Page 1 and verify Question 1 and Question 2 are NOT duplicates
  await check('Live Generation: Q1 and Q2 have distinct stems, non-duplicated option sets, and different correct answers', async () => {
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      selected_pages: [1],
      title: 'E2E Cell Biology Page 1 Test',
      subject: 'Cytology and Cell Architecture',
      institution: 'Kabul University',
      faculty: 'Faculty of Science',
      groups_count: 2,
      question_types_config: { mcq: 2, true_false: 1 },
    });

    assert.strictEqual(res.statusCode, 201, `Failed to generate exam: ${res.statusCode} ${JSON.stringify(res.body)}`);
    generatedExamId = res.body.id;
    assert.ok(generatedExamId, 'Exam ID must be generated');

    const groupA = res.body.groups[0];
    assert.strictEqual(groupA.questions.length, 3, 'Group A must contain 3 questions');

    const q1 = groupA.questions[0];
    const q2 = groupA.questions[1];
    const q3 = groupA.questions[2];

    console.log(`\n    Generated Q1: "${q1.question_text}"`);
    console.log(`    Generated Q2: "${q2.question_text}"`);
    console.log(`    Generated Q3: "${q3.question_text}"\n`);

    // Verify stems are strictly distinct
    assert.notStrictEqual(
      normalizeQuestionText(q1.question_text),
      normalizeQuestionText(q2.question_text),
      'Q1 and Q2 stems must not match'
    );

    // Verify semantic duplicate detector returns false
    assert.strictEqual(areQuestionsDuplicate(q1, q2), false, 'Q1 and Q2 must not be semantic duplicates');
    assert.strictEqual(areQuestionsDuplicate(q1, q3), false, 'Q1 and Q3 must not be semantic duplicates');
    assert.strictEqual(areQuestionsDuplicate(q2, q3), false, 'Q2 and Q3 must not be semantic duplicates');

    // Verify correct answers are distinct
    assert.notStrictEqual(q1.correct_answer, q2.correct_answer, 'Q1 and Q2 must have different correct answers');

    // Verify options are not reordered copies of each other
    const opts1 = normalizeQuestionOptions(q1.options);
    const opts2 = normalizeQuestionOptions(q2.options);
    assert.notDeepStrictEqual(opts1, opts2, 'Q1 and Q2 must have distinct option sets');
  });

  // 2. Source-page references and page isolation
  await check('Live Generation: Questions are strictly grounded with page_number = 1 and source_evidence', async () => {
    const res = await httpGet(`${BASE_URL}/api/exams/${generatedExamId}`);
    assert.strictEqual(res.statusCode, 200);
    const exam = JSON.parse(res.buffer.toString('utf8'));

    for (const group of exam.groups) {
      for (const q of group.questions) {
        assert.strictEqual(q.source_page, 1, `Question must originate from Page 1, got: ${q.source_page}`);
        assert.ok(q.source_evidence && q.source_evidence.length > 10, 'Question must include source evidence citation');
        // Page 1 should not mention Mitochondria or Glycolysis from Page 2
        assert.ok(!q.question_text.toLowerCase().includes('mitochondria'), 'Page 1 must not contain Page 2 mitochondria content');
        assert.ok(!q.question_text.toLowerCase().includes('glycolysis'), 'Page 1 must not contain Page 2 glycolysis content');
      }
    }
  });

  // 3. Page 2 isolation
  await check('Live Generation: Page 2 produces distinct questions without leaking Page 1 content', async () => {
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      selected_pages: [2],
      title: 'E2E Page 2 Bioenergetics Exam',
      subject: 'Bioenergetics',
      groups_count: 1,
      question_types_config: { mcq: 2, true_false: 1 },
    });

    assert.strictEqual(res.statusCode, 201);
    const questions = res.body.groups[0].questions;
    assert.strictEqual(questions.length, 3);

    for (const q of questions) {
      assert.strictEqual(q.source_page, 2, 'Must originate from Page 2');
      assert.ok(!q.question_text.toLowerCase().includes('nucleus'), 'Page 2 question must not leak Page 1 nucleus');
      assert.ok(!q.question_text.toLowerCase().includes('ribosome'), 'Page 2 question must not leak Page 1 ribosome');
    }

    // Pairwise non-duplicate check
    assert.strictEqual(areQuestionsDuplicate(questions[0], questions[1]), false);
    assert.strictEqual(areQuestionsDuplicate(questions[1], questions[2]), false);
    assert.strictEqual(areQuestionsDuplicate(questions[0], questions[2]), false);
  });

  // 4. Quota shortfall behavior
  await check('Live Quota Shortfall: Refuses to generate duplicate questions when quota exceeds source material', async () => {
    // Request 15 MCQs on Page 1 which only has ~5 distinct facts
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      selected_pages: [1],
      title: 'Over-Quota Exam',
      subject: 'Cell Biology',
      groups_count: 1,
      question_types_config: { mcq: 15 },
    });

    assert.strictEqual(res.statusCode, 422, 'Must return HTTP 422 Unprocessable Entity');
    assert.ok(res.body.detail, 'Must return error detail message');
    assert.ok(
      res.body.detail.includes('Selected page(s) [1] contain sufficient source material for only') ||
      res.body.detail.includes('reduce the question quota'),
      `Shortfall detail message received: "${res.body.detail}"`
    );
    console.log(`    Server Shortfall Response: "${res.body.detail}"`);
  });

  // 5. Anti-cheating isomorphic groups maintain distinctness within each group
  await check('Live Multi-Group Anti-Cheating: All groups maintain pairwise distinct questions', async () => {
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      title: 'E2E Multi-Group Exam',
      subject: 'Comprehensive Biology',
      groups_count: 3,
      question_types_config: { mcq: 2, true_false: 1 },
    });

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.groups.length, 3, 'Must have 3 groups');

    for (const group of res.body.groups) {
      const qs = group.questions;
      assert.strictEqual(qs.length, 3, `${group.group_name} must have 3 questions`);
      for (let i = 0; i < qs.length; i++) {
        for (let j = i + 1; j < qs.length; j++) {
          assert.strictEqual(
            areQuestionsDuplicate(qs[i], qs[j]),
            false,
            `In ${group.group_name}, question ${i + 1} and ${j + 1} must not be duplicates`
          );
        }
      }
    }
  });

  // 6. Newly generated exam exports valid PDF and DOCX
  await check('Live Exports: Newly generated exam exports valid PDF and DOCX without errors', async () => {
    // Export DOCX
    const docxRes = await httpGet(`${BASE_URL}/api/exams/${generatedExamId}/export/docx?target=exam`);
    assert.strictEqual(docxRes.statusCode, 200, 'DOCX export must return HTTP 200');
    assert.ok(docxRes.buffer.length > 2000, `DOCX buffer must be non-empty, got ${docxRes.buffer.length} bytes`);

    // Export PDF
    const pdfRes = await httpGet(`${BASE_URL}/api/exams/${generatedExamId}/export/pdf?target=exam`);
    assert.strictEqual(pdfRes.statusCode, 200, 'PDF export must return HTTP 200');
    assert.ok(pdfRes.buffer.length > 5000, `PDF buffer must be non-empty, got ${pdfRes.buffer.length} bytes`);
    assert.strictEqual(pdfRes.buffer.subarray(0, 4).toString(), '%PDF', 'Must be a valid PDF document');
  });

  console.log('\n======================================================');
  console.log(`  ALL ${passed}/${total} LIVE E2E VERIFICATION CHECKS PASSED!`);
  console.log('======================================================\n');
}

runLiveVerification().catch((err) => {
  console.error('\nE2E Verification Failed:', err);
  process.exit(1);
});
