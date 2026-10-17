import puppeteer from '/root/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import http from 'http';

function makeRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        let parsed = null;
        try {
          parsed = JSON.parse(buffer.toString('utf-8'));
        } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsed || buffer.toString('utf-8'),
          rawBuffer: buffer,
        });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runAllTests() {
  console.log('==================================================');
  console.log('EXAMCRAFT AI: VERIFICATION & REGRESSION TEST SUITE');
  console.log('==================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passedTests++;
    } else {
      console.error(`  [FAIL] ${message}`);
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  // -------------------------------------------------------------------------
  // TEST 1: Backend MCQ Option Editing & Multi-Group Consistency
  // -------------------------------------------------------------------------
  console.log('--- TEST SET 1: MCQ Options Editing & Backend Synchronization ---');
  const examsRes = await makeRequest('http://localhost:3000/api/exams');
  assert(examsRes.statusCode === 200, 'GET /api/exams returns 200');
  const exam = examsRes.data[0];
  assert(exam && exam.groups.length === 3, 'Default exam has 3 groups');

  const groupA = exam.groups[0];
  const targetMCQ = groupA.questions.find((q) => q.question_type === 'mcq');
  assert(targetMCQ !== undefined, 'Found target MCQ question in Group A');

  // Edit all 4 options, change correct answer, update explanation and marks
  const originalQId = targetMCQ.id;
  const newOptions = [
    'Organelle A: Mitochondria producing ATP',
    'Organelle B: Nucleus housing genomic DNA chromatin',
    'Organelle C: Endoplasmic reticulum synthesizing lipids',
    'Organelle D: Golgi apparatus packaging vesicles',
  ];
  const newCorrectAnswer = 'Organelle B: Nucleus housing genomic DNA chromatin';
  const newExplanation = 'The nucleus is the eukaryotic organelle containing chromatin and regulating gene expression.';
  const newMarks = 3.5;

  const putRes = await makeRequest(
    `http://localhost:3000/api/exams/${exam.id}/questions/${originalQId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    },
    {
      question_text: 'Identify the organelle responsible for storing eukaryotic genomic DNA.',
      marks: newMarks,
      options: newOptions,
      correct_answer: newCorrectAnswer,
      explanation: newExplanation,
    }
  );

  assert(putRes.statusCode === 200, 'PUT /api/exams/:id/questions/:qid returns 200');
  assert(putRes.data.marks === newMarks, 'Updated marks persisted to 3.5');
  assert(putRes.data.options.length === 4, 'All four options saved');
  assert(putRes.data.correct_answer === newCorrectAnswer, 'Correct answer updated to Organelle B');
  assert(putRes.data.explanation === newExplanation, 'Explanation updated and saved');

  // Verify multi-group synchronization across Group B and Group C
  const freshExamRes = await makeRequest(`http://localhost:3000/api/exams/${exam.id}`);
  assert(freshExamRes.statusCode === 200, 'GET /api/exams/:id returns 200');
  const freshExam = freshExamRes.data;

  for (let gIdx = 0; gIdx < freshExam.groups.length; gIdx++) {
    const grp = freshExam.groups[gIdx];
    const match = grp.questions.find((q) => q.question_text.includes('Identify the organelle responsible'));
    assert(match !== undefined, `Group ${grp.group_name} contains synchronized question`);
    assert(match.marks === newMarks, `Group ${grp.group_name} has matching marks ${newMarks}`);
    assert(match.correct_answer === newCorrectAnswer, `Group ${grp.group_name} has matching correct_answer text`);
    assert(match.options.length === 4, `Group ${grp.group_name} has 4 options`);
    // Options should contain all choices (possibly shifted for anti-cheating)
    for (const opt of newOptions) {
      assert(match.options.includes(opt), `Group ${grp.group_name} options include "${opt}"`);
    }
  }

  // Verify answer keys
  const akRes = await makeRequest(`http://localhost:3000/api/exams/${exam.id}/answer-key`);
  assert(akRes.statusCode === 200, 'GET /api/exams/:id/answer-key returns 200');
  for (const akGroup of akRes.data) {
    const akItem = akGroup.items.find((it) => it.correct_answer === newCorrectAnswer);
    assert(akItem !== undefined, `Answer key for ${akGroup.group_name} reflects new correct answer`);
  }

  // -------------------------------------------------------------------------
  // TEST 2: Question Deletion, Minimum Quota Guard & Multi-Group Cascade
  // -------------------------------------------------------------------------
  console.log('\n--- TEST SET 2: Question Deletion & Integrity Guard ---');
  const initialPerGroupCount = freshExam.groups[0].questions.length;
  const initialTotalQuestions = freshExam.questions_count;
  const initialTotalMarks = freshExam.total_marks;

  // Invalid question ID -> 404
  const delBadRes = await makeRequest(
    `http://localhost:3000/api/exams/${exam.id}/questions/invalid-question-id-12345`,
    { method: 'DELETE' }
  );
  assert(delBadRes.statusCode === 404, 'DELETE invalid question returns 404 Not Found');

  // Delete a valid question
  const questionToDelete = freshExam.groups[0].questions[freshExam.groups[0].questions.length - 1];
  const qDelMarks = questionToDelete.marks;
  const delRes = await makeRequest(
    `http://localhost:3000/api/exams/${exam.id}/questions/${questionToDelete.id}`,
    { method: 'DELETE' }
  );

  assert(delRes.statusCode === 200, 'DELETE question returns 200 OK');
  assert(delRes.data.deleted_count === 3, 'Question synchronized deletion across all 3 groups');
  assert(delRes.data.remaining_questions_per_group === initialPerGroupCount - 1, 'Group questions count decremented');

  // Verify exam state after deletion
  const postDelExamRes = await makeRequest(`http://localhost:3000/api/exams/${exam.id}`);
  const postDelExam = postDelExamRes.data;
  assert(postDelExam.groups[0].questions.length === initialPerGroupCount - 1, 'Group 0 questions reduced by 1');
  assert(postDelExam.questions_count === (initialPerGroupCount - 1) * 3, 'Total questions count updated');
  assert(
    Math.abs(postDelExam.total_marks - (initialTotalMarks - qDelMarks)) < 0.01,
    `Total marks recalculated: was ${initialTotalMarks}, now ${postDelExam.total_marks}`
  );

  // Verify sequential re-numbering across all groups
  for (const grp of postDelExam.groups) {
    const orders = grp.questions.map((q) => q.question_order);
    assert(
      JSON.stringify(orders) === JSON.stringify(orders.map((_, i) => i + 1)),
      `Group ${grp.group_name} re-sequenced sequentially: [${orders.join(', ')}]`
    );
  }

  // Test minimum questions guard (cannot delete when only 1 question remains)
  console.log('Testing minimum questions constraint guard...');
  // Delete down to 1 question
  while (postDelExam.groups[0].questions.length > 1) {
    const nextQ = postDelExam.groups[0].questions[postDelExam.groups[0].questions.length - 1];
    await makeRequest(`http://localhost:3000/api/exams/${exam.id}/questions/${nextQ.id}`, { method: 'DELETE' });
    const r = await makeRequest(`http://localhost:3000/api/exams/${exam.id}`);
    postDelExam.groups = r.data.groups;
  }
  assert(postDelExam.groups[0].questions.length === 1, 'Only 1 question remains in exam group');

  // Attempt to delete last remaining question -> must return 400
  const lastQ = postDelExam.groups[0].questions[0];
  const delLastRes = await makeRequest(
    `http://localhost:3000/api/exams/${exam.id}/questions/${lastQ.id}`,
    { method: 'DELETE' }
  );
  assert(delLastRes.statusCode === 400, 'DELETE last question returns 400 (Cannot delete: must retain >= 1 question)');
  assert(
    delLastRes.data.detail.includes('at least one question'),
    'Detailed error message returned explaining constraint'
  );

  // -------------------------------------------------------------------------
  // TEST 3: DOCX & PDF Export Regression Verification
  // -------------------------------------------------------------------------
  console.log('\n--- TEST SET 3: DOCX & PDF Exports Integrity ---');
  const docxRes = await makeRequest(`http://localhost:3000/api/exams/${exam.id}/export/docx?target=both`);
  assert(docxRes.statusCode === 200, 'GET export/docx returns 200');
  assert(docxRes.headers['content-type'].includes('wordprocessingml'), 'DOCX Content-Type valid');
  assert(docxRes.rawBuffer.length > 1000, `DOCX payload size valid (${docxRes.rawBuffer.length} bytes)`);

  const pdfRes = await makeRequest(`http://localhost:3000/api/exams/${exam.id}/export/pdf?target=both`);
  assert(pdfRes.statusCode === 200, 'GET export/pdf returns 200');
  assert(pdfRes.headers['content-type'].includes('application/pdf'), 'PDF Content-Type valid');
  assert(pdfRes.rawBuffer.length > 1000, `PDF payload size valid (${pdfRes.rawBuffer.length} bytes)`);

  // -------------------------------------------------------------------------
  // TEST 4: Browser End-to-End: Print Sheet & UI Actions
  // -------------------------------------------------------------------------
  console.log('\n--- TEST SET 4: Browser End-to-End Test (Chromium) ---');
  const browser = await puppeteer.launch({
    executablePath: '/root/.cache/puppeteer/chrome/linux-155.0.8059.39/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    const consoleLogs = [];
    page.on('console', (msg) => consoleLogs.push(msg.text()));

    // Spy on window.print
    await page.evaluateOnNewDocument(() => {
      window.__printCalls = 0;
      window.__printCallTime = null;
      window.print = function () {
        window.__printCalls++;
        window.__printCallTime = Date.now();
        console.log('[BROWSER] window.print() triggered!');
      };
    });

    await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });

    // Click Step 3
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const s3 = btns.find((b) => b.innerText.includes('Review Groups & Answer Keys'));
      return s3 && !s3.disabled;
    });

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const s3 = btns.find((b) => b.innerText.includes('Review Groups & Answer Keys'));
      s3.click();
    });

    // Check visible "Delete Question" button exists
    await page.waitForSelector('button');
    const hasDeleteQuestionBtn = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some((b) => b.innerText.includes('Delete Question'));
    });
    assert(hasDeleteQuestionBtn, 'Clearly visible "Delete Question" button is rendered on question card');

    // Check visible "Edit" button exists
    const hasEditBtn = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some((b) => b.innerText === 'Edit' || b.innerText.includes('Edit'));
    });
    assert(hasEditBtn, 'Edit Question button is rendered on question card');

    // Click "Paper Preview & Print"
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const prev = btns.find((b) => b.innerText.includes('Paper Preview & Print'));
      prev.click();
    });

    // Wait for "Print Sheet" button
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some((b) => b.innerText.includes('Print Sheet'));
    });

    // Click "Print Sheet" button
    console.log('Testing Print Sheet button click in real browser...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const printBtn = btns.find((b) => b.innerText.includes('Print Sheet'));
      printBtn.click();
    });

    // Verify window.print was called
    const printCallResult = await page.evaluate(() => ({
      calls: window.__printCalls,
      time: window.__printCallTime,
    }));
    assert(printCallResult.calls >= 1, 'Print Sheet button executes window.print() in browser');

    // Test print media styles
    await page.emulateMediaType('print');
    const mediaCheck = await page.evaluate(() => {
      const noPrintEls = Array.from(document.querySelectorAll('.no-print'));
      const allNoPrintHidden = noPrintEls.every((el) => window.getComputedStyle(el).display === 'none');
      const sheets = Array.from(document.querySelectorAll('.paper-sheet'));
      const sheetsVisible = sheets.every((el) => window.getComputedStyle(el).display !== 'none');
      return { allNoPrintHidden, sheetsVisible, sheetCount: sheets.length };
    });

    assert(mediaCheck.allNoPrintHidden, 'All navigation, headers, and toolbars hidden during print');
    assert(mediaCheck.sheetsVisible, 'Examination paper sheets remain visible and styled for print');

  } finally {
    await browser.close();
  }

  console.log('\n==================================================');
  console.log(`ALL TESTS PASSED! (${passedTests} / ${totalTests} assertions passed)`);
  console.log('==================================================');
}

runAllTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
