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

function httpGetJson(url, token) {
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
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        } catch {
          resolve({ statusCode: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runDuplicateDetectionSuite() {
  console.log('\n======================================================');
  console.log('  EXAMCRAFT AI: SEMANTIC DUPLICATE & GROUNDING SUITE  ');
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

  // 1. UNIT TEST: Semantic Duplicate Detector detects identical stem + reordered options
  await test('Semantic Detector: Detects identical question stem with reordered options', () => {
    const q1 = {
      question_type: 'mcq',
      question_text: 'According to the analysis in Section "Cell Architecture", what is a primary principle demonstrated by bound ribosomes?',
      options: [
        'It synthesizes secretory proteins and lysosomal enzymes for export.',
        'It prioritizes single-point hardware dependencies.',
        'It restricts data management exclusively to offline local storage.',
        'It demonstrates that hardware failures cause outages.',
      ],
      correct_answer: 'It synthesizes secretory proteins and lysosomal enzymes for export.',
    };

    const q2 = {
      question_type: 'mcq',
      question_text: 'According to the analysis in Section "Cell Architecture", what is a primary principle demonstrated by bound ribosomes?',
      options: [
        'It prioritizes single-point hardware dependencies.',
        'It demonstrates that hardware failures cause outages.',
        'It synthesizes secretory proteins and lysosomal enzymes for export.',
        'It restricts data management exclusively to offline local storage.',
      ],
      correct_answer: 'It synthesizes secretory proteins and lysosomal enzymes for export.',
    };

    assert.strictEqual(areQuestionsDuplicate(q1, q2), true, 'Must detect reordered options as duplicate');
  });

  // 2. UNIT TEST: Semantic Detector detects slight wording variation with same answer
  await test('Semantic Detector: Detects slight wording variation with identical answers/options', () => {
    const q1 = {
      question_type: 'mcq',
      question_text: 'What is the primary cellular function of mitochondria in eukaryotic organisms?',
      options: [
        'Generating ATP molecules through oxidative phosphorylation and cellular respiration.',
        'Synthesizing lipid bilayer membranes for nuclear pore complexes.',
        'Directing chromatin fiber unwinding during ribosomal transcription.',
        'Degrading exogenous enzymatic substrates via hydrolytic vacuolation.',
      ],
      correct_answer: 'Generating ATP molecules through oxidative phosphorylation and cellular respiration.',
    };

    const q2 = {
      question_type: 'mcq',
      question_text: 'In eukaryotic organisms, which of the following represents the primary function of mitochondria?',
      options: [
        'Degrading exogenous enzymatic substrates via hydrolytic vacuolation.',
        'Generating ATP molecules through oxidative phosphorylation and cellular respiration.',
        'Synthesizing lipid bilayer membranes for nuclear pore complexes.',
        'Directing chromatin fiber unwinding during ribosomal transcription.',
      ],
      correct_answer: 'Generating ATP molecules through oxidative phosphorylation and cellular respiration.',
    };

    assert.strictEqual(areQuestionsDuplicate(q1, q2), true, 'Must detect paraphrased stem with matching choices as duplicate');
  });

  // 3. UNIT TEST: Semantic Detector correctly distinguishes distinct questions
  await test('Semantic Detector: Accurately passes distinct, non-duplicate questions', () => {
    const q1 = {
      question_type: 'mcq',
      question_text: 'Which statement accurately describes the function of the cell nucleus as an organelle?',
      options: [
        'It houses hereditary genetic material as chromatin and coordinates ribosomal RNA transcription in the nucleolus.',
        'It serves as the primary site of aerobic cellular ATP generation.',
        'It directly hydrolyzes extracellular lipids through digestive lysosomal vacuolation.',
        'It transports atmospheric carbon dioxide across the plasma membrane.',
      ],
      correct_answer: 'It houses hereditary genetic material as chromatin and coordinates ribosomal RNA transcription in the nucleolus.',
    };

    const q2 = {
      question_type: 'mcq',
      question_text: 'What is the primary catalytic function of ribosomes in eukaryotic cells?',
      options: [
        'Translating mRNA sequences into polypeptide chains during protein synthesis.',
        'Synthesizing lipid bilayer membranes for nuclear pore complexes.',
        'Oxidizing glucose into pyruvate via anaerobic fermentation.',
        'Replicating chromosomal DNA molecules during the S phase.',
      ],
      correct_answer: 'Translating mRNA sequences into polypeptide chains during protein synthesis.',
    };

    assert.strictEqual(areQuestionsDuplicate(q1, q2), false, 'Distinct questions must not be flagged as duplicates');
  });

  // 4. API TEST: Live Generation on Page 1 produces ZERO duplicates between Q1 and Q2
  let generatedExamId = '';
  await test('API Question Generation: Page 1 creates distinct questions without duplicate stems or reordered choices', async () => {
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      selected_pages: [1],
      title: 'Cell Biology Page 1 Exam',
      subject: 'Cytology',
      groups_count: 1,
      question_types_config: { mcq: 2, true_false: 1 },
    });

    assert.strictEqual(res.statusCode, 201, `Status must be 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    generatedExamId = res.body.id;
    const questions = res.body.groups[0].questions;
    assert.strictEqual(questions.length, 3, 'Must have exactly 3 questions');

    const [q1, q2, q3] = questions;
    // Check Q1 vs Q2
    assert.notStrictEqual(normalizeQuestionText(q1.question_text), normalizeQuestionText(q2.question_text), 'Q1 and Q2 must have different question stems');
    assert.strictEqual(areQuestionsDuplicate(q1, q2), false, 'Q1 and Q2 must NOT be semantic duplicates');
    assert.notStrictEqual(q1.correct_answer, q2.correct_answer, 'Q1 and Q2 must have different correct answers');

    // Verify option uniqueness
    const opts1 = normalizeQuestionOptions(q1.options);
    const opts2 = normalizeQuestionOptions(q2.options);
    assert.notDeepStrictEqual(opts1, opts2, 'Q1 and Q2 must not have identical/reordered option sets');

    // Verify Page 1 isolation
    for (const q of questions) {
      assert.strictEqual(q.source_page, 1, 'Question must be strictly sourced from Page 1');
      assert.ok(!q.question_text.includes('Mitochondria'), 'Page 1 questions must not leak Page 2 Mitochondria');
      assert.ok(!q.question_text.includes('Glycolysis'), 'Page 1 questions must not leak Page 2 Glycolysis');
    }
  });

  // 5. API TEST: Page 2 Isolation
  await test('API Question Generation: Page 2 is strictly isolated from Page 1', async () => {
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      selected_pages: [2],
      title: 'Cell Biology Bioenergetics Exam',
      subject: 'Cellular Respiration',
      groups_count: 1,
      question_types_config: { mcq: 2, true_false: 1 },
    });

    assert.strictEqual(res.statusCode, 201);
    const questions = res.body.groups[0].questions;
    assert.strictEqual(questions.length, 3);

    for (const q of questions) {
      assert.strictEqual(q.source_page, 2, 'Question must originate from Page 2');
      assert.ok(!q.question_text.includes('nucleus'), 'Page 2 question must not leak Page 1 nucleus');
      assert.ok(!q.question_text.includes('Ribosomes are catalytic'), 'Page 2 question must not leak Page 1 ribosomes');
    }

    // Verify no duplicates in Group A
    for (let i = 0; i < questions.length; i++) {
      for (let j = i + 1; j < questions.length; j++) {
        assert.strictEqual(areQuestionsDuplicate(questions[i], questions[j]), false, `Question ${i + 1} and ${j + 1} must not be duplicates`);
      }
    }
  });

  // 6. API TEST: Insufficient source content quota shortfall reporting
  await test('API Quota Shortfall: Refuses to invent questions or duplicate options when material is insufficient', async () => {
    // Request 15 MCQs on Page 1 which only contains 7 sentences
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      selected_pages: [1],
      title: 'Excessive Quota Exam',
      subject: 'Cytology',
      groups_count: 1,
      question_types_config: { mcq: 15 },
    });

    assert.strictEqual(res.statusCode, 422, 'Must return 422 for quota exceeding distinct source facts');
    assert.ok(res.body.detail, 'Must provide detailed error response');
    assert.ok(
      res.body.detail.includes('sufficient source material for only') ||
      res.body.detail.includes('reduce the question quota') ||
      res.body.detail.includes('Selected page(s)'),
      `Error detail must clearly explain shortfall: ${res.body.detail}`
    );
  });

  // 7. API TEST: Multi-group exam has zero pairwise duplicates in every group
  await test('API Multi-Group Exam: All groups maintain pairwise distinct questions', async () => {
    const res = await httpPostJson(`${BASE_URL}/api/exams/generate`, {
      document_id: 'doc-cell-biology-101',
      title: 'Multi-Group Midterm',
      subject: 'Cell Biology',
      groups_count: 3,
      question_types_config: { mcq: 2, true_false: 1, short_answer: 1 },
    });

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.groups.length, 3, 'Must generate 3 groups');

    for (const group of res.body.groups) {
      const qs = group.questions;
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

  console.log('\n======================================================');
  console.log(`  ALL ${passed}/${total} DUPLICATE & GROUNDING TESTS PASSED!`);
  console.log('======================================================\n');
}

runDuplicateDetectionSuite().catch((err) => {
  console.error('\nSuite Failed:', err);
  process.exit(1);
});
