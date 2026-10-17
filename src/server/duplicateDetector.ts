export interface QuestionCandidate {
  question_type: string;
  question_text: string;
  options?: string[] | null;
  correct_answer?: string;
  source_page?: number;
  source_evidence?: string;
  [key: string]: any;
}

export function normalizeQuestionText(text: string): string {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'«»[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeQuestionOptions(options: string[] | null | undefined): string[] {
  if (!options || !Array.isArray(options)) return [];
  return options
    .map((opt) => {
      const s = String(opt).replace(/^(\([A-Za-z0-9\u0621-\u064A]+\)|[A-Za-z0-9\u0621-\u064A]+[:.)\-]|➢)\s*/, '');
      return normalizeQuestionText(s);
    })
    .filter(Boolean)
    .sort();
}

export function getQuestionTokens(text: string): Set<string> {
  const stopwords = new Set([
    'what', 'which', 'how', 'why', 'when', 'where', 'who', 'is', 'are', 'was', 'were', 'the', 'a', 'an',
    'in', 'on', 'at', 'of', 'for', 'to', 'from', 'by', 'with', 'about', 'according', 'statement', 'accurately',
    'describes', 'function', 'primary', 'principle', 'demonstrated', 'section', 'analysis', 'true', 'false',
    'concise', 'sentences', 'explain', 'discuss', 'synthesize', 'evaluate', 'complete', 'following', 'based',
    'کدام', 'چه', 'چگونه', 'چرا', 'آیا', 'بر', 'اساس', 'طبق', 'متن', 'منبع', 'بخش', 'مطرح', 'شده', 'مفهوم',
    'اساسی', 'درستی', 'بیان', 'می', 'کند', 'صحیح', 'غلط', 'تحلیل', 'مورد', 'یکی', 'از', 'و', 'به', 'در', 'با'
  ]);
  const words = normalizeQuestionText(text).split(' ').filter((w) => w.length > 2 && !stopwords.has(w));
  return new Set(words);
}

export function computeJaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function areQuestionsDuplicate(q1: QuestionCandidate, q2: QuestionCandidate): boolean {
  // 1. Exact or near-exact question stem match after normalization
  const normText1 = normalizeQuestionText(q1.question_text);
  const normText2 = normalizeQuestionText(q2.question_text);
  if (normText1 === normText2) {
    return true;
  }

  // 2. Answer choices set overlap (detects reordered options or slightly perturbed choices)
  if (q1.options && q2.options && q1.options.length > 0 && q2.options.length > 0) {
    const opts1 = normalizeQuestionOptions(q1.options);
    const opts2 = normalizeQuestionOptions(q2.options);
    const set1 = new Set(opts1);
    const set2 = new Set(opts2);
    const optOverlap = computeJaccardSimilarity(set1, set2);
    // If 3 of 4 options are identical (>= 0.70 overlap), it is a duplicate question regardless of order!
    if (optOverlap >= 0.70) {
      return true;
    }
  }

  // 3. Question stem keyword overlap (Jaccard similarity >= 0.75)
  const kw1 = getQuestionTokens(q1.question_text);
  const kw2 = getQuestionTokens(q2.question_text);
  const stemSim = computeJaccardSimilarity(kw1, kw2);
  if (stemSim >= 0.75) {
    return true;
  }

  // 4. Identical correct answer AND high stem similarity (>= 0.40) or exact same source evidence
  if (q1.correct_answer && q2.correct_answer) {
    const normAns1 = normalizeQuestionText(q1.correct_answer);
    const normAns2 = normalizeQuestionText(q2.correct_answer);
    if (normAns1 === normAns2 || computeJaccardSimilarity(new Set(normAns1.split(' ')), new Set(normAns2.split(' '))) >= 0.8) {
      if (stemSim >= 0.40) {
        return true;
      }
      if (q1.source_evidence && q2.source_evidence && normalizeQuestionText(q1.source_evidence) === normalizeQuestionText(q2.source_evidence)) {
        return true;
      }
    }
  }

  return false;
}
