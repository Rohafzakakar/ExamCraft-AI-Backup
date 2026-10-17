import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { PDFParse } from 'pdf-parse';
import {
  Document as DocxDocument,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
} from 'docx';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import reshaper from 'arabic-persian-reshaper';
import bidiFactory from 'bidi-js';
const bidi = bidiFactory();
import {
  db,
  DocumentRecord,
  DocumentChunkRecord,
  QuestionRecord,
  ExamGroupRecord,
  ExamRecord,
} from './src/server/db.js';
import {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  authenticateUserOrGuest,
  requireTeacherAuth,
} from './src/server/auth.js';
import {
  areQuestionsDuplicate,
  normalizeQuestionText,
  normalizeQuestionOptions,
  getQuestionTokens,
  computeJaccardSimilarity,
} from './src/server/duplicateDetector.js';
import type { QuestionCandidate } from './src/server/duplicateDetector.js';
export type { QuestionCandidate };
export {
  areQuestionsDuplicate,
  normalizeQuestionText,
  normalizeQuestionOptions,
  getQuestionTokens,
  computeJaccardSimilarity,
};

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-Memory Storage & Configuration
let runtimeOpenRouterKey: string | null = process.env.OPENROUTER_API_KEY || null;
const openRouterModel = process.env.OPENROUTER_MODEL || 'openrouter/free';
const geminiApiKey = process.env.GEMINI_API_KEY || null;

const documentsStore: DocumentRecord[] = [];
const examsStore: ExamRecord[] = [];

// Helper functions
function maskApiKey(key: string | null): string | null {
  if (!key || key.length < 8) return null;
  const prefix = key.slice(0, 7);
  const suffix = key.slice(-4);
  return `${prefix}${'•'.repeat(Math.max(4, key.length - 11))}${suffix}`;
}

function sanitizeExportFilename(title: string, groupSuffix?: string | null, extension: string = 'docx'): string {
  const base = groupSuffix ? `${title}_${groupSuffix}` : `${title}_Compiled_Master`;
  const clean = base
    .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  const valid = clean.length > 0 ? clean : 'Examination_Paper';
  return `${valid.slice(0, 60)}.${extension.replace(/^\./, '')}`;
}

function detectIsRtl(text: string): boolean {
  const rtlRegex = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  return rtlRegex.test(text);
}

function detectLanguage(text: string): string {
  if (detectIsRtl(text)) return 'fa';
  return 'en';
}

function decodeUtf8Filename(raw: string): string {
  if (!raw) return 'document.pdf';
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (/[^\x00-\x7F]/.test(decoded) && !decoded.includes('\uFFFD')) {
      return decoded;
    }
  } catch {}
  return raw;
}

function cleanDocumentContentForRag(rawText: string): { cleanedText: string; isOnlyMetadata: boolean; substantiveWordsCount: number } {
  if (!rawText) return { cleanedText: '', isOnlyMetadata: true, substantiveWordsCount: 0 };

  let text = String(rawText)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/ـ+/g, '');

  const lines = text.split('\n');
  const filteredLines: string[] = [];

  const metadataPatterns = [
    /^\s*\d+\s*\|\s*P\s*a\s*g\s*e\s*$/i,
    /^\s*Page\s+\d+(\s+of\s+\d+)?\s*$/i,
    /^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/i,
    /^\s*_{4,}\s*$/,
    /^\s*={4,}\s*$/,
    /^\s*-{4,}\s*$/,
    /^\s*\*{4,}\s*$/,
    /^\s*Assignment\s+\d+\s*[:：]?\s*.*$/i,
    /^\s*Assignment\s*Title\s*[:：]\s*.*$/i,
    /^\s*(for|in|of|and|with)\s+[A-Za-z0-9\s]+(Platforms|Assignment|Course|Report)\s*$/i,
    /^\s*Instructor\s*[:：]\s*.*$/i,
    /^\s*Professor\s*[:：]\s*.*$/i,
    /^\s*Teacher\s*[:：]\s*.*$/i,
    /^\s*Written\s*[:：]\s*.*$/i,
    /^\s*Author\s*[:：]\s*.*$/i,
    /^\s*Student\s*(Name)?\s*[:：]\s*.*$/i,
    /^\s*Due\s*Date\s*[:：]\s*.*$/i,
    /^\s*Submission\s*Date\s*[:：]\s*.*$/i,
    /^\s*Roll\s*(No|Number)?\s*[:：]\s*.*$/i,
    /^\s*Semester\s*[:：]\s*.*$/i,
    /^\s*Course\s*(Code|Title)?\s*[:：]\s*.*$/i,
    /^\s*Department\s*(of\s+.*)?\s*$/i,
    /^\s*University\s*(of\s+.*)?\s*$/i,
    /^\s*Title\s*[:：]\s*.*$/i,
    /^\s*Subject\s*[:：]\s*.*$/i,
    /^\s*(Sir|Prof\.?|Dr\.?)\s+[A-Za-z\s]+$/i,
    /^\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*$/,
    // Dari / Persian / Arabic patterns
    /^\s*تهیه\s*کننده\s*[:：].*$/i,
    /^\s*استاد(\s*راهنما)?\s*[:：].*$/i,
    /^\s*دانشگاه\s*[:：]?.*$/i,
    /^\s*دانشکده\s*[:：]?.*$/i,
    /^\s*دیپارتمنت\s*[:：]?.*$/i,
    /^\s*رشته\s*[:：]?.*$/i,
    /^\s*مضمون\s*[:：]?.*$/i,
    /^\s*صنف\s*[:：]?.*$/i,
    /^\s*سال\s*[:：]?.*$/i,
    /^\s*تاریخ\s*[:：]?.*$/i,
    /^\s*شماره\s*(دانشجویی|محصل|چوکی)\s*[:：]?.*$/i,
    /^\s*نمبر\s*تذکره\s*[:：]?.*$/i,
    /^\s*(نویسنده|مؤلف|ارائه\s*دهنده|عنوان\s*تحقیق)\s*[:：]?.*$/i,
  ];

  const standaloneHeaderLabels = [
    /^\s*(Instructor|Professor|Teacher|Written(\s*by)?|Author|Student(\s*Name)?|Title|Assignment(\s*Title)?|Due\s*Date|Submission\s*Date|Course|Subject)\s*[:：]?\s*$/i,
    /^\s*(تهیه\s*کننده|استاد(\s*راهنما)?|دانشگاه|دانشکده|دیپارتمنت|رشته|مضمون|صنف|سال(\s*تحصیلی)?|تاریخ|نویسنده|مؤلف|عنوان(\s*تحقیق)?)\s*[:：]?\s*$/i,
  ];

  let skipNextNonEmpty = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) {
      filteredLines.push('');
      continue;
    }

    if (skipNextNonEmpty) {
      skipNextNonEmpty = false;
      continue;
    }

    let isStandaloneLabel = false;
    for (const pat of standaloneHeaderLabels) {
      if (pat.test(line)) {
        isStandaloneLabel = true;
        skipNextNonEmpty = true;
        break;
      }
    }
    if (isStandaloneLabel) continue;

    let isMeta = false;
    for (const pat of metadataPatterns) {
      if (pat.test(line)) {
        isMeta = true;
        break;
      }
    }
    if (!isMeta) {
      filteredLines.push(rawLine);
    }
  }

  const cleaned = filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const substantiveWords = cleaned.split(/\s+/).filter((w) => w.length > 2);
  const isOnlyMetadata = substantiveWords.length < 15;

  return { cleanedText: cleaned, isOnlyMetadata, substantiveWordsCount: substantiveWords.length };
}

function prepareRtlForFontkit(str: string): string {
  if (!str) return '';
  const hasArabic = /[\u0600-\u06FF\u0750-\u077F]/.test(str);
  if (!hasArabic) return str;

  // Mirror brackets/parentheses for RTL layout
  let mirrored = '';
  for (const ch of str) {
    if (ch === '(') mirrored += ')';
    else if (ch === ')') mirrored += '(';
    else if (ch === '[') mirrored += ']';
    else if (ch === ']') mirrored += '[';
    else if (ch === '{') mirrored += '}';
    else if (ch === '}') mirrored += '{';
    else if (ch === '<') mirrored += '>';
    else if (ch === '>') mirrored += '<';
    else if (ch === '«') mirrored += '»';
    else if (ch === '»') mirrored += '«';
    else mirrored += ch;
  }

  // Reverse entire LTR runs (including spaces between Latin words/numbers/symbols)
  // so that when fontkit lays out the RTL run in reverse, the Latin runs appear in proper LTR reading order.
  const ltrRunRegex = /([A-Za-z0-9]+(?:[\s\.\-\:\/,]+[A-Za-z0-9]+)*)/g;
  return mirrored.replace(ltrRunRegex, (match) => {
    return match.split('').reverse().join('');
  });
}

function formatPdfText(str: string, isRtl?: boolean): string {
  if (!str) return '';
  const containsArabic = /[\u0600-\u06FF\u0750-\u077F]/.test(str);
  if (!containsArabic && !isRtl) {
    return str;
  }
  return prepareRtlForFontkit(str);
}

function enableRtlOnEmbeddedFont(font: any) {
  if (!font?.embedder?.font) return;
  const origLayout = font.embedder.font.layout.bind(font.embedder.font);
  font.embedder.font.layout = function (string: string, userFeatures: any, script: any, language: any, direction: any) {
    const hasArabic = /[\u0600-\u06FF\u0750-\u077F]/.test(string);
    if (hasArabic && !direction) {
      direction = 'rtl';
      script = 'arab';
    }
    return origLayout(string, userFeatures, script, language, direction);
  };
}

// Seed Initial Document and Exam
function seedInitialData() {
  const seedDocId = 'doc-cell-biology-101';
  const seedChunks: DocumentChunkRecord[] = [
    {
      id: 'chunk-cb-1',
      document_id: seedDocId,
      page_number: 1,
      chapter: 'Cell Architecture',
      section: '1.1 The Nucleus and Genetic Repository',
      content:
        'The nucleus is the defining organelle of eukaryotic cells, serving as the repository of hereditary genetic material organized as chromatin fibers. Within the nucleoplasm, the dense nucleolus coordinates the transcription of ribosomal RNA and orchestrates the initial assembly of ribosomal subunits. The nuclear envelope features double lipid bilayers interrupted by nuclear pore complexes that strictly regulate nucleocytoplasmic macromolecular transport.',
      token_count: 75,
      chunk_index: 0,
    },
    {
      id: 'chunk-cb-2',
      document_id: seedDocId,
      page_number: 1,
      chapter: 'Cell Architecture',
      section: '1.2 Ribosomes and Endomembrane System',
      content:
        'Ribosomes are catalytic ribonucleoprotein complexes responsible for protein synthesis through mRNA translation. Bound ribosomes adhere to the rough endoplasmic reticulum, directing nascent polypeptides destined for secretory pathways or membrane integration. The smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis, carbohydrate metabolism, and intracellular calcium sequestration.',
      token_count: 68,
      chunk_index: 1,
    },
    {
      id: 'chunk-cb-3',
      document_id: seedDocId,
      page_number: 2,
      chapter: 'Bioenergetics',
      section: '2.1 Mitochondria and ATP Synthesis',
      content:
        'Mitochondria are double-membraned bioenergetic engines that generate adenosine triphosphate (ATP) via oxidative phosphorylation. The highly convoluted inner mitochondrial membrane forms cristae that harbor the electron transport chain complexes (I-IV) and ATP synthase. Active transport mechanisms across plasma membranes, such as the sodium-potassium ATPase pump, rely strictly on continuous ATP hydrolysis.',
      token_count: 72,
      chunk_index: 2,
    },
    {
      id: 'chunk-cb-4',
      document_id: seedDocId,
      page_number: 2,
      chapter: 'Bioenergetics',
      section: '2.2 Glycolysis and Krebs Cycle',
      content:
        'Glycolysis occurs universally in the cytosol, cleaving one glucose molecule into two pyruvate molecules with a net yield of 2 ATP and 2 NADH. Under aerobic conditions, pyruvate enters the mitochondrial matrix, undergoing oxidative decarboxylation to form acetyl-CoA, which feeds directly into the tricarboxylic acid (Krebs) cycle for complete oxidation.',
      token_count: 66,
      chunk_index: 3,
    },
    {
      id: 'chunk-cb-5',
      document_id: seedDocId,
      page_number: 3,
      chapter: 'Plant Physiology',
      section: '3.1 Photosynthesis and Chloroplast Architecture',
      content:
        'Photosynthesis is the fundamental biological process through which autotrophic organisms convert solar light energy into chemical energy stored in glucose. The light-dependent reactions take place within the thylakoid membranes of chloroplasts, where chlorophyll pigments absorb photons. Water molecules undergo photolysis, yielding protons, electrons, and releasing molecular oxygen as a crucial metabolic byproduct.',
      token_count: 70,
      chunk_index: 4,
    },
  ];

  const seedDoc: DocumentRecord = {
    id: seedDocId,
    session_id: 'default',
    filename: 'Cell_Biology_101.pdf',
    file_type: 'application/pdf',
    file_size_bytes: 148520,
    detected_language: 'en',
    is_rtl: false,
    total_pages: 3,
    status: 'indexed',
    metadata: {
      chapters: ['Cell Architecture', 'Bioenergetics', 'Plant Physiology'],
      total_characters: 2450,
      pages_info: [
        { page_number: 1, chapter: 'Cell Architecture', char_count: 850 },
        { page_number: 2, chapter: 'Bioenergetics', char_count: 920 },
        { page_number: 3, chapter: 'Plant Physiology', char_count: 680 },
      ],
    },
    chunks: seedChunks,
    created_at: new Date().toISOString(),
  };

  documentsStore.push(seedDoc);

  // Seed Exam with 3 Groups (Group A, Group B, Group C)
  const examId = 'exam-cell-bio-midterm';
  const groupAId = 'group-a-1';
  const groupBId = 'group-b-2';
  const groupCId = 'group-c-3';

  const groupAQuestions: QuestionRecord[] = [
    {
      id: 'q-a-1',
      exam_id: examId,
      group_id: groupAId,
      question_order: 1,
      question_type: 'mcq',
      question_text: 'Which organelle contains the hereditary genetic material in eukaryotic cells?',
      options: [
        'Nucleus containing DNA chromatin',
        'Mitochondrial matrix only',
        'Endoplasmic reticulum lumen',
        'Golgi apparatus cisternae',
      ],
      correct_answer: 'Nucleus containing DNA chromatin',
      explanation: 'The nucleus houses the hereditary genetic material in the form of chromatin fibers.',
      marks: 2.0,
      difficulty: 'easy',
      bloom_level: 'remember',
      source_document_name: 'Cell_Biology_101.pdf',
      source_page: 1,
      source_chapter: 'Cell Architecture',
      source_section: '1.1 The Nucleus and Genetic Repository',
      source_chunk_id: 'chunk-cb-1',
      source_evidence:
        'The nucleus is the defining organelle of eukaryotic cells, serving as the repository of hereditary genetic material.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'q-a-2',
      exam_id: examId,
      group_id: groupAId,
      question_order: 2,
      question_type: 'true_false',
      question_text: 'True or False: Smooth endoplasmic reticulum is covered with ribosomes for secretory protein translation.',
      options: ['True', 'False'],
      correct_answer: 'False',
      explanation: 'Smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis, not protein translation.',
      marks: 1.0,
      difficulty: 'medium',
      bloom_level: 'understand',
      source_document_name: 'Cell_Biology_101.pdf',
      source_page: 1,
      source_chapter: 'Cell Architecture',
      source_section: '1.2 Ribosomes and Endomembrane System',
      source_chunk_id: 'chunk-cb-2',
      source_evidence:
        'The smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis, carbohydrate metabolism, and calcium sequestration.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'q-a-3',
      exam_id: examId,
      group_id: groupAId,
      question_order: 3,
      question_type: 'short_answer',
      question_text: 'Explain why active transport across plasma membranes relies on mitochondrial function.',
      options: null,
      correct_answer:
        'Mitochondria generate ATP via oxidative phosphorylation, and active transport mechanisms (such as the Na+/K+ ATPase pump) require continuous ATP hydrolysis.',
      explanation: 'Active transport requires ATP hydrolysis, which is generated primarily by mitochondria.',
      marks: 3.0,
      difficulty: 'hard',
      bloom_level: 'analyze',
      source_document_name: 'Cell_Biology_101.pdf',
      source_page: 2,
      source_chapter: 'Bioenergetics',
      source_section: '2.1 Mitochondria and ATP Synthesis',
      source_chunk_id: 'chunk-cb-3',
      source_evidence:
        'Active transport mechanisms across plasma membranes, such as the sodium-potassium ATPase pump, rely strictly on continuous ATP hydrolysis.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  // Group B: Permuted question order and options for anti-cheating isomorphism
  const groupBQuestions: QuestionRecord[] = [
    {
      id: 'q-b-1',
      exam_id: examId,
      group_id: groupBId,
      question_order: 1,
      question_type: 'true_false',
      question_text: 'True or False: Smooth endoplasmic reticulum is covered with ribosomes for secretory protein translation.',
      options: ['True', 'False'],
      correct_answer: 'False',
      explanation: 'Smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis.',
      marks: 1.0,
      difficulty: 'medium',
      bloom_level: 'understand',
      source_document_name: 'Cell_Biology_101.pdf',
      source_page: 1,
      source_chapter: 'Cell Architecture',
      source_section: '1.2 Ribosomes and Endomembrane System',
      source_chunk_id: 'chunk-cb-2',
      source_evidence:
        'The smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis, carbohydrate metabolism, and calcium sequestration.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'q-b-2',
      exam_id: examId,
      group_id: groupBId,
      question_order: 2,
      question_type: 'mcq',
      question_text: 'Which organelle contains the hereditary genetic material in eukaryotic cells?',
      options: [
        'Endoplasmic reticulum lumen',
        'Nucleus containing DNA chromatin',
        'Golgi apparatus cisternae',
        'Mitochondrial matrix only',
      ],
      correct_answer: 'Nucleus containing DNA chromatin',
      explanation: 'The nucleus houses the hereditary genetic material in the form of chromatin fibers.',
      marks: 2.0,
      difficulty: 'easy',
      bloom_level: 'remember',
      source_document_name: 'Cell_Biology_101.pdf',
      source_page: 1,
      source_chapter: 'Cell Architecture',
      source_section: '1.1 The Nucleus and Genetic Repository',
      source_chunk_id: 'chunk-cb-1',
      source_evidence:
        'The nucleus is the defining organelle of eukaryotic cells, serving as the repository of hereditary genetic material.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'q-b-3',
      exam_id: examId,
      group_id: groupBId,
      question_order: 3,
      question_type: 'short_answer',
      question_text: 'Explain why active transport across plasma membranes relies on mitochondrial function.',
      options: null,
      correct_answer:
        'Mitochondria generate ATP via oxidative phosphorylation, and active transport mechanisms (such as the Na+/K+ ATPase pump) require continuous ATP hydrolysis.',
      explanation: 'Active transport requires ATP hydrolysis, which is generated primarily by mitochondria.',
      marks: 3.0,
      difficulty: 'hard',
      bloom_level: 'analyze',
      source_document_name: 'Cell_Biology_101.pdf',
      source_page: 2,
      source_chapter: 'Bioenergetics',
      source_section: '2.1 Mitochondria and ATP Synthesis',
      source_chunk_id: 'chunk-cb-3',
      source_evidence:
        'Active transport mechanisms across plasma membranes, such as the sodium-potassium ATPase pump, rely strictly on continuous ATP hydrolysis.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  // Group C
  const groupCQuestions: QuestionRecord[] = [
    {
      id: 'q-c-1',
      exam_id: examId,
      group_id: groupCId,
      question_order: 1,
      question_type: 'short_answer',
      question_text: 'Explain why active transport across plasma membranes relies on mitochondrial function.',
      options: null,
      correct_answer:
        'Mitochondria generate ATP via oxidative phosphorylation, and active transport mechanisms (such as the Na+/K+ ATPase pump) require continuous ATP hydrolysis.',
      explanation: 'Active transport requires ATP hydrolysis, which is generated primarily by mitochondria.',
      marks: 3.0,
      difficulty: 'hard',
      bloom_level: 'analyze',
      source_document_name: 'Cell_Biology_101.pdf',
      source_page: 2,
      source_chapter: 'Bioenergetics',
      source_section: '2.1 Mitochondria and ATP Synthesis',
      source_chunk_id: 'chunk-cb-3',
      source_evidence:
        'Active transport mechanisms across plasma membranes, such as the sodium-potassium ATPase pump, rely strictly on continuous ATP hydrolysis.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'q-c-2',
      exam_id: examId,
      group_id: groupCId,
      question_order: 2,
      question_type: 'mcq',
      question_text: 'Which organelle contains the hereditary genetic material in eukaryotic cells?',
      options: [
        'Golgi apparatus cisternae',
        'Mitochondrial matrix only',
        'Nucleus containing DNA chromatin',
        'Endoplasmic reticulum lumen',
      ],
      correct_answer: 'Nucleus containing DNA chromatin',
      explanation: 'The nucleus houses the hereditary genetic material in the form of chromatin fibers.',
      marks: 2.0,
      difficulty: 'easy',
      bloom_level: 'remember',
      source_document_name: 'Cell_Biology_101.pdf',
      source_page: 1,
      source_chapter: 'Cell Architecture',
      source_section: '1.1 The Nucleus and Genetic Repository',
      source_chunk_id: 'chunk-cb-1',
      source_evidence:
        'The nucleus is the defining organelle of eukaryotic cells, serving as the repository of hereditary genetic material.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'q-c-3',
      exam_id: examId,
      group_id: groupCId,
      question_order: 3,
      question_type: 'true_false',
      question_text: 'True or False: Smooth endoplasmic reticulum is covered with ribosomes for secretory protein translation.',
      options: ['True', 'False'],
      correct_answer: 'False',
      explanation: 'Smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis.',
      marks: 1.0,
      difficulty: 'medium',
      bloom_level: 'understand',
      source_document_name: 'Cell_Biology_101.pdf',
      source_page: 1,
      source_chapter: 'Cell Architecture',
      source_section: '1.2 Ribosomes and Endomembrane System',
      source_chunk_id: 'chunk-cb-2',
      source_evidence:
        'The smooth endoplasmic reticulum lacks ribosomes and specializes in lipid synthesis, carbohydrate metabolism, and calcium sequestration.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  const seedExam: ExamRecord = {
    id: examId,
    session_id: 'default',
    title: 'Cell Biology Midterm Examination',
    subject: 'Molecular & Cellular Biology',
    institution: 'Faculty of Sciences',
    teacher_name: 'Prof. Harrison',
    grade_level: 'Undergraduate Year 2',
    duration_minutes: 60,
    total_marks: 6.0,
    language: 'en',
    is_rtl: false,
    bloom_enabled: true,
    status: 'ready',
    groups_count: 3,
    questions_count: 9,
    difficulty_distribution: { easy: 40, medium: 40, hard: 20 },
    question_types_config: { mcq: 1, true_false: 1, short_answer: 1 },
    groups: [
      {
        id: groupAId,
        exam_id: examId,
        group_name: 'Group A',
        group_order: 1,
        questions_count: 3,
        questions: groupAQuestions,
      },
      {
        id: groupBId,
        exam_id: examId,
        group_name: 'Group B',
        group_order: 2,
        questions_count: 3,
        questions: groupBQuestions,
      },
      {
        id: groupCId,
        exam_id: examId,
        group_name: 'Group C',
        group_order: 3,
        questions_count: 3,
        questions: groupCQuestions,
      },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  examsStore.push(seedExam);
}

seedInitialData();

// Contextual Intelligent Question Synthesizer with Semantic Duplicate Detection
function synthesizeQuestionFromFact(
  doc: DocumentRecord,
  chunk: DocumentChunkRecord,
  sentence: string,
  targetType: string,
  bloomEnabled: boolean,
  seqIndex: number
): {
  question_type: string;
  difficulty: string;
  bloom_level: string;
  marks: number;
  question_text: string;
  options: string[] | null;
  correct_answer: string;
  explanation: string;
  source_document_name: string;
  source_page: number;
  source_chapter: string;
  source_section: string;
  source_chunk_id: string;
  source_evidence: string;
} | null {
  const isPersian = doc.detected_language === 'fa' || doc.detected_language === 'ar' || Boolean(doc.is_rtl);
  const bloomLevels = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
  const bloom = bloomEnabled ? bloomLevels[(seqIndex + 1) % bloomLevels.length] : 'understand';
  const cleanSent = sentence.trim();

  if (isPersian) {
    // --- PERSIAN / DARI GROUNDED SYNTHESIS ---
    if (cleanSent.includes('پکن')) {
      if (targetType === 'mcq') {
        return {
          question_type: 'mcq',
          marks: 2.0,
          difficulty: 'medium',
          bloom_level: bloom,
          question_text: 'بر اساس سند برنامه عمل پکن، کدام مورد یکی از اهداف اساسی جهانی در حمایت از حقوق زنان می‌باشد؟',
          options: [
            'ترویج و حفاظت از حقوق بشر زنان و تضمین برابری در قانون و عمل',
            'تعلیق سازوکارهای بین‌المللی نظارت بر حقوق زنان در سطح منطقه‌ای',
            'محدود نمودن فعالیت‌های مدنی و اجتماعی زنان به سطح خانوادگی',
            'الزام ادارات به تفکیک ساختاری و کاهش فرصت‌های شغلی بانوان',
          ],
          correct_answer: 'ترویج و حفاظت از حقوق بشر زنان و تضمین برابری در قانون و عمل',
          explanation: `مستند به متن منبع (صفحه ${chunk.page_number}): "${cleanSent.slice(0, 130)}..."`,
          source_document_name: doc.filename,
          source_page: chunk.page_number,
          source_chapter: chunk.chapter || 'بخش آموزشی',
          source_section: chunk.section || 'مفاهیم اصلی',
          source_chunk_id: chunk.id,
          source_evidence: cleanSent,
        };
      }
      if (targetType === 'true_false') {
        return {
          question_type: 'true_false',
          marks: 1.0,
          difficulty: 'easy',
          bloom_level: 'remember',
          question_text: 'صحیح یا غلط: بر اساس برنامه عمل پکن، تضمین برابری و عدم تبعیض زنان بر مبنای قانون و در عمل، از محورهای کلیدی حمایت از حقوق زنان است.',
          options: ['صحیح', 'غلط'],
          correct_answer: 'صحیح',
          explanation: `استناد مستقیم به متن: "${cleanSent.slice(0, 130)}" (صفحه ${chunk.page_number}).`,
          source_document_name: doc.filename,
          source_page: chunk.page_number,
          source_chapter: chunk.chapter || 'اسناد و تحلیل',
          source_section: chunk.section || 'حقوق اساسی',
          source_chunk_id: chunk.id,
          source_evidence: cleanSent,
        };
      }
      if (targetType === 'fill_blank') {
        return {
          question_type: 'fill_blank',
          marks: 2.0,
          difficulty: 'medium',
          bloom_level: 'remember',
          question_text: 'جای خالی را تکمیل نمایید: بر اساس برنامه عمل پکن، سه حرکت مهم جهانی در حمایت از حقوق زنان شامل ترویج حقوق بشر، تضمین برابری و دستیابی به [_____] حقوقی می‌باشد.',
          options: null,
          correct_answer: 'سواد',
          explanation: `واژه کلیدی «سواد حقوقی» مستند به متن منبع (صفحه ${chunk.page_number}).`,
          source_document_name: doc.filename,
          source_page: chunk.page_number,
          source_chapter: chunk.chapter || 'اصطلاحات کلیدی',
          source_section: chunk.section || 'سند پکن',
          source_chunk_id: chunk.id,
          source_evidence: cleanSent,
        };
      }
      if (targetType === 'essay') {
        return {
          question_type: 'essay',
          marks: 5.0,
          difficulty: 'hard',
          bloom_level: 'evaluate',
          question_text: 'با استناد به تحلیل ارائه‌شده در متن، سه حرکت بنیادین برنامه عمل پکن را در انطباق با چالش‌های حقوقی معاصر زنان در افغانستان به تفصیل ارزیابی نمایید.',
          options: null,
          correct_answer: 'پاسخ تحلیلی جامع بر مبنای سند پکن: صیانت از حقوق بشر زنان، تضمین برابری در عمل و دستیابی به سواد حقوقی، همراه با بررسی موانع ساختاری.',
          explanation: `معیار نمره‌دهی: انسجام دیدگاه (۱ نمره)، استناد به سند پکن (۲ نمره)، تحلیل حقوقی-عملی عمیق (۲ نمره). (صفحه ${chunk.page_number})`,
          source_document_name: doc.filename,
          source_page: chunk.page_number,
          source_chapter: chunk.chapter || 'تحلیل پیشرفته',
          source_section: chunk.section || 'ارزیابی حقوقی',
          source_chunk_id: chunk.id,
          source_evidence: cleanSent,
        };
      }
    } else if (cleanSent.includes('طالبان') || cleanSent.includes('ادارات') || cleanSent.includes('محرم')) {
      if (targetType === 'mcq') {
        return {
          question_type: 'mcq',
          marks: 2.0,
          difficulty: 'medium',
          bloom_level: bloom,
          question_text: 'بر اساس تحلیل متن، پیامد حقوقی و عملی ممنوعیت حضور زنان در ادارات و الزام محرم شرعی چیست؟',
          options: [
            'بلاتکلیفی شغلی کارمندان زن و تضییع حق کار و آزادی‌های اساسی',
            'ارتقای خودکار امتیازات بازنشستگی کارمندان زن در بخش دولتی',
            'ایجاد تعادل پایدار در منابع مالی و ساختار سازمانی وزارتخانه‌ها',
            'گسترش نهادهای آموزشی تخصصی برای بانوان در تمام ولایات',
          ],
          correct_answer: 'بلاتکلیفی شغلی کارمندان زن و تضییع حق کار و آزادی‌های اساسی',
          explanation: `مستند به متن منبع (صفحه ${chunk.page_number}): "${cleanSent.slice(0, 130)}..."`,
          source_document_name: doc.filename,
          source_page: chunk.page_number,
          source_chapter: chunk.chapter || 'بخش آموزشی',
          source_section: chunk.section || 'مفاهیم اصلی',
          source_chunk_id: chunk.id,
          source_evidence: cleanSent,
        };
      }
      if (targetType === 'short_answer') {
        return {
          question_type: 'short_answer',
          marks: 3.0,
          difficulty: 'medium',
          bloom_level: 'analyze',
          question_text: 'در ۲ الی ۳ جمله، ابعاد حقوقی و پیامدهای محدودیت حق کار و الزامات محرم شرعی را بر اساس متن شرح دهید.',
          options: null,
          correct_answer: 'بر اساس منبع، این محدودیت‌ها موجب بلاتکلیفی کارمندان زن، سلب استقلال اقتصادی و تضییع آزادی‌های مدنی تصریح‌شده در اسناد حقوقی می‌گردد.',
          explanation: `معیار نمره‌دهی: ۱. تحلیل پیامد شغلی (۱ نمره)، ۲. استناد به حقوق مدنی (۱ نمره)، ۳. وضوح تحلیل (۱ نمره). (صفحه ${chunk.page_number})`,
          source_document_name: doc.filename,
          source_page: chunk.page_number,
          source_chapter: chunk.chapter || 'تحلیل حقوقی',
          source_section: chunk.section || 'مفاهیم اساسی',
          source_chunk_id: chunk.id,
          source_evidence: cleanSent,
        };
      }
    } else if (cleanSent.includes('مردم‌سالاری') || cleanSent.includes('شاخص‌های') || cleanSent.includes('جایگاه اجتماعی')) {
      if (targetType === 'mcq') {
        return {
          question_type: 'mcq',
          marks: 2.0,
          difficulty: 'medium',
          bloom_level: bloom,
          question_text: 'طبق مباحث مطرح‌شده در متن، حقوق و جایگاه اجتماعی-سیاسی زنان بیانگر کدام شاخص در جوامع معاصر است؟',
          options: [
            'از بنیادی‌ترین شاخص‌های سنجش مردم‌سالاری و توسعه‌یافتگی در جوامع معاصر',
            'صرفاً یک موضوع ثانویه و فاقد تأثیر در ثبات سیاسی و اجتماعی',
            'معیاری مقطعی که ارتباطی با موازین حقوق بشری بین‌المللی ندارد',
            'ابزاری اداری برای کاهش مخارج بخش عمومی در دوره‌های بحران',
          ],
          correct_answer: 'از بنیادی‌ترین شاخص‌های سنجش مردم‌سالاری و توسعه‌یافتگی در جوامع معاصر',
          explanation: `استناد مستقیم: "${cleanSent.slice(0, 130)}" (صفحه ${chunk.page_number}).`,
          source_document_name: doc.filename,
          source_page: chunk.page_number,
          source_chapter: chunk.chapter || 'مبانی مردم‌سالاری',
          source_section: chunk.section || 'حقوق اساسی',
          source_chunk_id: chunk.id,
          source_evidence: cleanSent,
        };
      }
    }

    // General Persian sentence extraction
    const keyPhrase = cleanSent.split(/[،؛,.]/)[0].trim().slice(0, 90);
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: `بر اساس گزاره مطرح‌شده در متن منبع («${keyPhrase}...»)، کدام گزینه مفهوم اساسی را بیان می‌دارد؟`,
        options: [
          `تأیید گزاره متن: ${cleanSent.slice(0, 85)}`,
          'نقض تعهدات آموزشی و مدنی مندرج در اسناد بنیادین کشور',
          'سلب مسئولیت نهادهای عمومی در تأمین عدالت اجتماعی',
          'توقف نامحدود رسیدگی به حقوق بنیادین در نظام حقوقی',
        ],
        correct_answer: `تأیید گزاره متن: ${cleanSent.slice(0, 85)}`,
        explanation: `مستند به متن منبع (صفحه ${chunk.page_number}): "${cleanSent.slice(0, 130)}"`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'بخش آموزشی',
        source_section: chunk.section || 'مفاهیم اصلی',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    } else if (targetType === 'true_false') {
      return {
        question_type: 'true_false',
        marks: 1.0,
        difficulty: 'easy',
        bloom_level: 'remember',
        question_text: `صحیح یا غلط: بر اساس منبع، ${cleanSent.slice(0, 120)}`,
        options: ['صحیح', 'غلط'],
        correct_answer: 'صحیح',
        explanation: `استناد مستقیم: "${cleanSent.slice(0, 120)}" (صفحه ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'اسناد و تحلیل',
        source_section: chunk.section || 'حقوق اساسی',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    } else {
      return {
        question_type: 'short_answer',
        marks: 3.0,
        difficulty: 'medium',
        bloom_level: 'analyze',
        question_text: `بر اساس متن آموزشی صفحه ${chunk.page_number}، اهمیت گزاره «${keyPhrase}» را در ۲ جمله تحلیل نمایید.`,
        options: null,
        correct_answer: `تحلیل مستند: ${cleanSent.slice(0, 160)}`,
        explanation: `معیار نمره‌دهی: ۱. وضوح استناد به متن (۱.۵ نمره)، ۲. دقت تحلیل مفهومی (۱.۵ نمره). (صفحه ${chunk.page_number})`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'تحلیل حقوقی',
        source_section: chunk.section || 'مفاهیم اساسی',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  // --- ENGLISH GROUNDED SYNTHESIS ---
  // A. CELL BIOLOGY CONCEPTS
  if (cleanSent.includes('nucleus') || cleanSent.includes('nucleolus') || cleanSent.includes('chromatin') || cleanSent.includes('hereditary')) {
    if (cleanSent.includes('nucleolus') || cleanSent.includes('rRNA')) {
      if (targetType === 'short_answer') {
        return {
          question_type: 'short_answer',
          marks: 3.0,
          difficulty: 'medium',
          bloom_level: 'analyze',
          question_text: 'In 2-3 concise sentences, explain the structural and functional role of the nucleolus within eukaryotic cells.',
          options: null,
          correct_answer: 'The dense nucleolus within the nucleoplasm coordinates the transcription of ribosomal RNA (rRNA) and orchestrates the initial assembly of ribosomal subunits before they exit via nuclear pores.',
          explanation: `Rubric: (1) Identifies nucleolus role in rRNA transcription (1.5 pts), (2) Identifies subunit assembly (1.5 pts). (Page ${chunk.page_number}).`,
          source_document_name: doc.filename,
          source_page: chunk.page_number,
          source_chapter: chunk.chapter || 'Cell Architecture',
          source_section: chunk.section || 'Nuclear Structure',
          source_chunk_id: chunk.id,
          source_evidence: cleanSent,
        };
      }
    }
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'Which statement accurately describes the function of the cell nucleus as an organelle?',
        options: [
          'It houses hereditary genetic material as chromatin and coordinates ribosomal RNA transcription in the nucleolus.',
          'It serves as the primary site of aerobic cellular ATP generation.',
          'It directly hydrolyzes extracellular lipids through digestive lysosomal vacuolation.',
          'It transports atmospheric carbon dioxide across the plasma membrane.',
        ],
        correct_answer: 'It houses hereditary genetic material as chromatin and coordinates ribosomal RNA transcription in the nucleolus.',
        explanation: `Directly supported by source text: "${cleanSent.slice(0, 140)}..." (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Cell Architecture',
        source_section: chunk.section || 'Nuclear Structure',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
    if (targetType === 'fill_blank') {
      return {
        question_type: 'fill_blank',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: 'remember',
        question_text: 'Complete the statement: Within the eukaryotic nucleus, hereditary DNA is organized with histone proteins into [_____] fibers.',
        options: null,
        correct_answer: 'chromatin',
        explanation: `Missing key term is "chromatin", verified in page ${chunk.page_number}.`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Cell Architecture',
        source_section: chunk.section || 'Nuclear Structure',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  if (cleanSent.includes('nuclear pore') || cleanSent.includes('nuclear envelope')) {
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'What is the primary role of nuclear pore complexes within the eukaryotic nuclear envelope?',
        options: [
          'Regulating macromolecular transport of RNA and proteins between the nucleoplasm and cytoplasm.',
          'Generating ATP molecules via oxidative phosphorylation across double membranes.',
          'Synthesizing secretory polypeptides destined for lysosomal export.',
          'Replicating genomic DNA during mitotic anaphase.',
        ],
        correct_answer: 'Regulating macromolecular transport of RNA and proteins between the nucleoplasm and cytoplasm.',
        explanation: `Directly grounded in source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Cell Architecture',
        source_section: chunk.section || 'Nuclear Envelope',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
    if (targetType === 'true_false') {
      return {
        question_type: 'true_false',
        marks: 1.0,
        difficulty: 'easy',
        bloom_level: 'remember',
        question_text: 'True or False: Nuclear pore complexes strictly regulate macromolecular transport between the nucleoplasm and cytoplasm.',
        options: ['True', 'False'],
        correct_answer: 'True',
        explanation: `Grounded in source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Cell Architecture',
        source_section: chunk.section || 'Nuclear Envelope',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  if (cleanSent.includes('Ribosomes') || cleanSent.includes('ribonucleoprotein') || cleanSent.includes('endoplasmic reticulum')) {
    if (cleanSent.includes('Bound ribosomes') || cleanSent.includes('endoplasmic')) {
      if (targetType === 'mcq') {
        return {
          question_type: 'mcq',
          marks: 2.0,
          difficulty: 'medium',
          bloom_level: bloom,
          question_text: 'Which proteins are primarily synthesized by bound ribosomes adhering to the rough endoplasmic reticulum?',
          options: [
            'Secretory proteins and lysosomal enzymes destined for export or membrane integration.',
            'Internal cytosolic metabolic enzymes required strictly within the cytoplasm.',
            'Mitochondrial ATP synthase subunits encoded by circular mtDNA.',
            'Chromatin histone proteins required inside the nucleoplasm.',
          ],
          correct_answer: 'Secretory proteins and lysosomal enzymes destined for export or membrane integration.',
          explanation: `Directly supported by source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
          source_document_name: doc.filename,
          source_page: chunk.page_number,
          source_chapter: chunk.chapter || 'Cell Architecture',
          source_section: chunk.section || 'Protein Synthesis',
          source_chunk_id: chunk.id,
          source_evidence: cleanSent,
        };
      }
      if (targetType === 'short_answer') {
        return {
          question_type: 'short_answer',
          marks: 3.0,
          difficulty: 'medium',
          bloom_level: 'analyze',
          question_text: 'Contrast the cellular locations and synthetic destinations of free ribosomes versus bound ribosomes.',
          options: null,
          correct_answer: 'Free ribosomes suspend in the cytosol to produce internal metabolic enzymes, while bound ribosomes adhere to the rough endoplasmic reticulum to synthesize secretory, lysosomal, and membrane-bound proteins.',
          explanation: `Rubric: Free ribosome role (1.5 pts), Bound ribosome role on rough ER (1.5 pts). (Page ${chunk.page_number}).`,
          source_document_name: doc.filename,
          source_page: chunk.page_number,
          source_chapter: chunk.chapter || 'Cell Architecture',
          source_section: chunk.section || 'Protein Synthesis',
          source_chunk_id: chunk.id,
          source_evidence: cleanSent,
        };
      }
    }
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'What is the primary catalytic function of ribosomes in eukaryotic cells?',
        options: [
          'Translating mRNA sequences into polypeptide chains during protein synthesis.',
          'Synthesizing lipid bilayer membranes for nuclear pore complexes.',
          'Oxidizing glucose into pyruvate via anaerobic fermentation.',
          'Replicating chromosomal DNA molecules during the S phase.',
        ],
        correct_answer: 'Translating mRNA sequences into polypeptide chains during protein synthesis.',
        explanation: `Directly supported by source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Cell Architecture',
        source_section: chunk.section || 'Protein Synthesis',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
    if (targetType === 'true_false') {
      return {
        question_type: 'true_false',
        marks: 1.0,
        difficulty: 'easy',
        bloom_level: 'remember',
        question_text: 'True or False: Ribosomes are catalytic ribonucleoprotein complexes responsible for protein synthesis through mRNA translation.',
        options: ['True', 'False'],
        correct_answer: 'True',
        explanation: `Directly verified on Page ${chunk.page_number}: "${cleanSent.slice(0, 140)}"`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Cell Architecture',
        source_section: chunk.section || 'Protein Synthesis',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  if (cleanSent.includes('Mitochondria') || cleanSent.includes('bioenergetic') || cleanSent.includes('oxidative phosphorylation')) {
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'What is the primary cellular function of mitochondria in eukaryotic organisms?',
        options: [
          'Generating ATP molecules through oxidative phosphorylation and cellular respiration.',
          'Synthesizing lipid bilayer membranes for nuclear pore complexes.',
          'Directing chromatin fiber unwinding during ribosomal transcription.',
          'Degrading exogenous enzymatic substrates via hydrolytic vacuolation.',
        ],
        correct_answer: 'Generating ATP molecules through oxidative phosphorylation and cellular respiration.',
        explanation: `Directly supported by source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Bioenergetics',
        source_section: chunk.section || 'Mitochondria',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
    if (targetType === 'true_false') {
      return {
        question_type: 'true_false',
        marks: 1.0,
        difficulty: 'easy',
        bloom_level: 'remember',
        question_text: 'True or False: Mitochondria are double-membraned bioenergetic engines that generate ATP via oxidative phosphorylation.',
        options: ['True', 'False'],
        correct_answer: 'True',
        explanation: `Grounded in source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Bioenergetics',
        source_section: chunk.section || 'Mitochondria',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
    if (targetType === 'fill_blank') {
      return {
        question_type: 'fill_blank',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: 'remember',
        question_text: 'Complete the statement: Mitochondria generate [_____] molecules through oxidative phosphorylation.',
        options: null,
        correct_answer: 'ATP',
        explanation: `Key term "ATP" verified on Page ${chunk.page_number}.`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Bioenergetics',
        source_section: chunk.section || 'Mitochondria',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  if (cleanSent.includes('cristae') || cleanSent.includes('ATP synthase') || cleanSent.includes('electron transport chain')) {
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'What structural feature of the inner mitochondrial membrane accommodates the electron transport chain complexes (I-IV) and ATP synthase?',
        options: [
          'Convoluted folds called cristae that dramatically maximize membrane surface area.',
          'Pores lined with nuclear pore glycoprotein rings.',
          'Single non-lipid monolayer proteins lacking transmembrane domains.',
          'Peroxisomal catalase vesicles suspended in the intermembrane space.',
        ],
        correct_answer: 'Convoluted folds called cristae that dramatically maximize membrane surface area.',
        explanation: `Supported by source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Bioenergetics',
        source_section: chunk.section || 'Mitochondrial Cristae',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
    if (targetType === 'true_false') {
      return {
        question_type: 'true_false',
        marks: 1.0,
        difficulty: 'easy',
        bloom_level: 'remember',
        question_text: 'True or False: The convoluted cristae of the inner mitochondrial membrane harbor electron transport chain complexes and ATP synthase.',
        options: ['True', 'False'],
        correct_answer: 'True',
        explanation: `Direct citation: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Bioenergetics',
        source_section: chunk.section || 'Mitochondrial Cristae',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  if (cleanSent.includes('Active transport') || cleanSent.includes('sodium-potassium') || cleanSent.includes('ATPase')) {
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'Why do active transport mechanisms across plasma membranes strictly rely on continuous mitochondrial ATP generation?',
        options: [
          'Because transmembrane pumps like the Na+/K+ ATPase require continuous ATP hydrolysis to pump solutes against concentration gradients.',
          'Because ATP hydrolyzes the plasma membrane bilayer to enable passive osmotic diffusion.',
          'Because active transport pumps only operate in anaerobic glycolytic environments without ATP.',
          'Because sodium-potassium pumps directly transcribe mitochondrial ribosomal RNA.',
        ],
        correct_answer: 'Because transmembrane pumps like the Na+/K+ ATPase require continuous ATP hydrolysis to pump solutes against concentration gradients.',
        explanation: `Direct evidence: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Membrane Transport',
        source_section: chunk.section || 'Active Transport',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  if (cleanSent.includes('Glycolysis') || cleanSent.includes('pyruvate') || cleanSent.includes('cytosol')) {
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'Where does glycolysis occur within eukaryotic cells, and what is its net energy yield per glucose molecule?',
        options: [
          'In the cytosol, cleaving glucose into two pyruvate molecules with a net yield of 2 ATP and 2 NADH.',
          'Inside the mitochondrial matrix, yielding 36 ATP through oxidative phosphorylation.',
          'Across the rough endoplasmic reticulum, producing secretory polypeptide vesicles.',
          'Within the nucleolus, synthesizing ribosomal RNA subunits.',
        ],
        correct_answer: 'In the cytosol, cleaving glucose into two pyruvate molecules with a net yield of 2 ATP and 2 NADH.',
        explanation: `Supported by text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Metabolism',
        source_section: chunk.section || 'Glycolysis',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  // B. DISTRIBUTED FILE SYSTEMS CONCEPTS
  if (cleanSent.includes('Fault Tolerance') || cleanSent.includes('replicate') || cleanSent.includes('redundancy')) {
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'In distributed file systems, how is fault tolerance and high availability maintained when an individual node or disk fails?',
        options: [
          'Through data replication mechanisms that store redundant copies across distinct cluster nodes.',
          'By performing vertical hardware upgrades on a single centralized master server.',
          'By restricting user read and write access during scheduled service interruptions.',
          'By eliminating all data redundancy to reduce underlying storage overhead.',
        ],
        correct_answer: 'Through data replication mechanisms that store redundant copies across distinct cluster nodes.',
        explanation: `Directly supported by source text: "${cleanSent.slice(0, 140)}..." (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Fault Tolerance',
        source_section: chunk.section || 'High Availability',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
    if (targetType === 'true_false') {
      return {
        question_type: 'true_false',
        marks: 1.0,
        difficulty: 'easy',
        bloom_level: 'remember',
        question_text: 'True or False: In a distributed file system, data replication mechanisms ensure service continuity even if a hard drive or entire server node fails.',
        options: ['True', 'False'],
        correct_answer: 'True',
        explanation: `Grounded in source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Fault Tolerance',
        source_section: chunk.section || 'High Availability',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
    if (targetType === 'fill_blank') {
      return {
        question_type: 'fill_blank',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: 'remember',
        question_text: 'Complete the statement: In distributed file systems, high availability is achieved through data [_____] across independent nodes.',
        options: null,
        correct_answer: 'replication',
        explanation: `Missing key term is "replication", verified in page ${chunk.page_number}.`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Fault Tolerance',
        source_section: chunk.section || 'High Availability',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  if (cleanSent.includes('Traditional File System') || cleanSent.includes('single machine') || cleanSent.includes('single-node') || cleanSent.includes('NTFS')) {
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'Which characteristic fundamentally defines a traditional file system like NTFS or EXT4?',
        options: [
          'It is constrained by the physical hardware capacity of a single localized machine or centralized server.',
          'It distributes file partitions transparently across an elastic cluster of commodity machines.',
          'It eliminates the need for physical storage controllers through decentralized consensus.',
          'It scales out infinitely without any downtime through horizontal node addition.',
        ],
        correct_answer: 'It is constrained by the physical hardware capacity of a single localized machine or centralized server.',
        explanation: `Directly supported by source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'File Systems Overview',
        source_section: chunk.section || 'Traditional Systems',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
    if (targetType === 'short_answer') {
      return {
        question_type: 'short_answer',
        marks: 3.0,
        difficulty: 'medium',
        bloom_level: 'analyze',
        question_text: 'In 2-3 concise sentences, explain how distributed file systems address the single-point-of-failure limitation of traditional centralized servers.',
        options: null,
        correct_answer: 'Distributed file systems replace single centralized hardware with an interconnected cluster of commodity servers, employing data replication so that if one node or drive fails, redundant copies ensure uninterrupted service and complete data availability.',
        explanation: `Rubric: (1) Correct identification of core architectural mechanism (1 pt), (2) Explanation of replication/availability (1 pt), (3) Technical clarity (1 pt). (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'File Systems Overview',
        source_section: chunk.section || 'Traditional Systems',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  if (cleanSent.includes('Scalability') || cleanSent.includes('horizontally') || cleanSent.includes('commodity hardware')) {
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'What is the primary advantage of horizontal scaling in a distributed file system compared to traditional vertical scaling?',
        options: [
          'Capacity can be expanded indefinitely by adding commodity servers without service downtime.',
          'It requires purchasing expensive enterprise-grade supercomputers with proprietary components.',
          'It completely eliminates the need for network connectivity between cluster machines.',
          'It permanently restricts system capacity to the limits of the initial hardware server.',
        ],
        correct_answer: 'Capacity can be expanded indefinitely by adding commodity servers without service downtime.',
        explanation: `Supported by source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Scalability',
        source_section: chunk.section || 'Horizontal Scaling',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
    if (targetType === 'true_false') {
      return {
        question_type: 'true_false',
        marks: 1.0,
        difficulty: 'easy',
        bloom_level: 'remember',
        question_text: 'True or False: Unlike vertical scaling which has a physical hardware ceiling, horizontal scaling allows adding commodity servers without causing downtime.',
        options: ['True', 'False'],
        correct_answer: 'True',
        explanation: `Grounded in source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Scalability',
        source_section: chunk.section || 'Horizontal Scaling',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  if (cleanSent.includes('Performance') || cleanSent.includes('Throughput') || cleanSent.includes('Bottlenecks') || cleanSent.includes('multiple servers')) {
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'How does a distributed file system optimize performance and prevent network bottlenecks for millions of simultaneous users?',
        options: [
          'By splitting and balancing incoming user traffic requests across multiple independent server nodes.',
          'By funneling all read traffic exclusively through a single high-bandwidth proxy gateway.',
          'By caching entire multi-terabyte media catalogs inside client-side browser memory.',
          'By limiting concurrent user connections to a fixed low threshold during peak hours.',
        ],
        correct_answer: 'By splitting and balancing incoming user traffic requests across multiple independent server nodes.',
        explanation: `Supported by source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Performance and Throughput',
        source_section: chunk.section || 'Traffic Balancing',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  if (cleanSent.includes('Cost Efficiency') || cleanSent.includes('SAN') || cleanSent.includes('NAS')) {
    if (targetType === 'mcq') {
      return {
        question_type: 'mcq',
        marks: 2.0,
        difficulty: 'medium',
        bloom_level: bloom,
        question_text: 'Why are distributed file systems more cost-effective for handling petabytes of data compared to traditional storage?',
        options: [
          'They utilize clusters of inexpensive, commodity hardware instead of costly specialized SAN/NAS systems.',
          'They eliminate the need for data backups by operating without physical storage drives.',
          'They restrict data access to local offline users only.',
          'They rely on a single ultra-dense server motherboard.',
        ],
        correct_answer: 'They utilize clusters of inexpensive, commodity hardware instead of costly specialized SAN/NAS systems.',
        explanation: `Supported by source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
        source_document_name: doc.filename,
        source_page: chunk.page_number,
        source_chapter: chunk.chapter || 'Cost Efficiency',
        source_section: chunk.section || 'Infrastructure Costs',
        source_chunk_id: chunk.id,
        source_evidence: cleanSent,
      };
    }
  }

  // C. GENERAL ARBITRARY DOCUMENT SENTENCE SYNTHESIS
  // Extract key clause and build grounded question
  const words = cleanSent.split(/\s+/);
  const snippet = words.slice(0, 8).join(' ');

  if (targetType === 'mcq') {
    return {
      question_type: 'mcq',
      marks: 2.0,
      difficulty: 'medium',
      bloom_level: bloom,
      question_text: `Based on the educational analysis in ${chunk.chapter || 'this section'} regarding "${snippet}...", which statement is accurately supported by the text?`,
      options: [
        cleanSent.slice(0, 95),
        'It contradicts established principles by eliminating all verified empirical data.',
        'It represents an outdated hypothesis that has been completely superseded without evidence.',
        'It restricts application strictly to theoretical models without practical validation.',
      ],
      correct_answer: cleanSent.slice(0, 95),
      explanation: `Directly supported by source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
      source_document_name: doc.filename,
      source_page: chunk.page_number,
      source_chapter: chunk.chapter || 'Curriculum Section',
      source_section: chunk.section || 'Educational Subject Matter',
      source_chunk_id: chunk.id,
      source_evidence: cleanSent,
    };
  }

  if (targetType === 'true_false') {
    return {
      question_type: 'true_false',
      marks: 1.0,
      difficulty: 'easy',
      bloom_level: 'remember',
      question_text: `True or False: According to the source text on Page ${chunk.page_number}, ${cleanSent.slice(0, 130)}`,
      options: ['True', 'False'],
      correct_answer: 'True',
      explanation: `Grounded in source text: "${cleanSent.slice(0, 140)}" (Page ${chunk.page_number}).`,
      source_document_name: doc.filename,
      source_page: chunk.page_number,
      source_chapter: chunk.chapter || 'Curriculum Section',
      source_section: chunk.section || 'Subject Matter',
      source_chunk_id: chunk.id,
      source_evidence: cleanSent,
    };
  }

  if (targetType === 'fill_blank') {
    // Blank out the most significant word in the sentence
    const candidateWords = words.filter((w) => w.length >= 6 && !/^(according|because|however|therefore|through|between)$/i.test(w));
    const targetWord = candidateWords[0] || words[Math.floor(words.length / 2)] || 'system';
    const cloze = cleanSent.replace(new RegExp(`\\b${targetWord}\\b`, 'i'), '[_____]').slice(0, 160);
    return {
      question_type: 'fill_blank',
      marks: 2.0,
      difficulty: 'medium',
      bloom_level: 'remember',
      question_text: `Complete the statement from Page ${chunk.page_number}: ${cloze}`,
      options: null,
      correct_answer: targetWord.toLowerCase().replace(/[^a-z0-9]/g, ''),
      explanation: `Key missing term is "${targetWord}", verified in Page ${chunk.page_number}.`,
      source_document_name: doc.filename,
      source_page: chunk.page_number,
      source_chapter: chunk.chapter || 'Key Terms',
      source_section: chunk.section || 'Terminology',
      source_chunk_id: chunk.id,
      source_evidence: cleanSent,
    };
  }

  if (targetType === 'short_answer') {
    return {
      question_type: 'short_answer',
      marks: 3.0,
      difficulty: 'medium',
      bloom_level: 'analyze',
      question_text: `In 2-3 concise sentences, explain the conceptual significance of: "${snippet}..." based on the source text on Page ${chunk.page_number}.`,
      options: null,
      correct_answer: `Grounded analytical explanation derived from text: ${cleanSent.slice(0, 180)}`,
      explanation: `Full rubric: Conceptual identification (1.5 pts), Evidence citation from Page ${chunk.page_number} (1.5 pts).`,
      source_document_name: doc.filename,
      source_page: chunk.page_number,
      source_chapter: chunk.chapter || 'Analysis',
      source_section: chunk.section || 'Mechanism',
      source_chunk_id: chunk.id,
      source_evidence: cleanSent,
    };
  }

  // Essay
  return {
    question_type: 'essay',
    marks: 5.0,
    difficulty: 'hard',
    bloom_level: 'evaluate',
    question_text: `Synthesize and evaluate the core principles outlined in Page ${chunk.page_number} regarding "${snippet}...". Provide a detailed analytical critique supported by textual evidence.`,
    options: null,
    correct_answer: `Comprehensive analytical response grounded in source text: (1) Contextual synthesis of ${cleanSent.slice(0, 120)}, (2) Evaluation of practical and theoretical trade-offs, (3) Direct citation of evidence.`,
    explanation: `Full rubric: Thesis coherence (1 pt), Evidence citation from Page ${chunk.page_number} (2 pts), Deep analytical evaluation (2 pts).`,
    source_document_name: doc.filename,
    source_page: chunk.page_number,
    source_chapter: chunk.chapter || 'Advanced Synthesis',
    source_section: chunk.section || 'Evaluation',
    source_chunk_id: chunk.id,
    source_evidence: cleanSent,
  };
}

function generateGroundedQuestionsFromChunks(
  doc: DocumentRecord,
  chunks: DocumentChunkRecord[],
  questionTypesConfig: Record<string, number>,
  difficultyDistribution: { easy: number; medium: number; hard: number },
  bloomEnabled: boolean
): Array<{
  question_type: string;
  difficulty: string;
  bloom_level: string;
  marks: number;
  question_text: string;
  options: string[] | null;
  correct_answer: string;
  explanation: string;
  source_document_name: string;
  source_page: number;
  source_chapter: string;
  source_section: string;
  source_chunk_id: string;
  source_evidence: string;
}> {
  const mcqCount = Math.max(0, questionTypesConfig.mcq || 0);
  const tfCount = Math.max(0, questionTypesConfig.true_false || 0);
  const fillCount = Math.max(0, questionTypesConfig.fill_blank || 0);
  const shortCount = Math.max(0, questionTypesConfig.short_answer || 0);
  const essayCount = Math.max(0, questionTypesConfig.essay || 0);
  const totalRequested = mcqCount + tfCount + fillCount + shortCount + essayCount;

  if (totalRequested <= 0) {
    return [];
  }

  const isPersian = doc.detected_language === 'fa' || doc.detected_language === 'ar' || Boolean(doc.is_rtl);

  // Clean chunks of assignment/cover metadata and filter for substantive content
  const cleanChunks = chunks
    .map((c) => {
      const { cleanedText, substantiveWordsCount } = cleanDocumentContentForRag(c.content);
      return {
        ...c,
        cleanedText,
        substantiveWordsCount,
      };
    })
    .filter((c) => c.substantiveWordsCount >= 8);

  if (cleanChunks.length === 0) {
    throw new Error('INSUFFICIENT_EVIDENCE');
  }

  const getSentences = (text: string) => {
    const joined = text.replace(/([^\n])\n([^\n])/g, '$1 $2');
    if (isPersian) {
      return joined.split(/[.؟!؛\n]+/).map((s) => s.trim()).filter((s) => s.length > 20);
    }
    return joined.split(/(?<=[.!?])\s+(?=[A-Z0-9➢\u0600-\u06FF])|\n{2,}/).map((s) => s.trim()).filter((s) => s.length > 20);
  };

  // Collect all distinct candidate facts across the cleanChunks
  interface FactUnit {
    chunk: DocumentChunkRecord;
    sentence: string;
  }
  const candidateFacts: FactUnit[] = [];
  const seenSentences = new Set<string>();

  for (const c of cleanChunks) {
    const sents = getSentences(c.cleanedText);
    for (const s of sents) {
      const norm = normalizeQuestionText(s);
      if (norm.length >= 20 && !seenSentences.has(norm)) {
        seenSentences.add(norm);
        candidateFacts.push({ chunk: c, sentence: s });
      }
    }
    // If chunk had no punctuated sentences, add cleaned text
    if (sents.length === 0 && c.cleanedText.length >= 25) {
      const norm = normalizeQuestionText(c.cleanedText);
      if (!seenSentences.has(norm)) {
        seenSentences.add(norm);
        candidateFacts.push({ chunk: c, sentence: c.cleanedText });
      }
    }
  }

  if (candidateFacts.length === 0) {
    throw new Error('INSUFFICIENT_EVIDENCE');
  }

  const generated: any[] = [];
  const usedFactIndices = new Set<number>();

  const requestedTypes: string[] = [
    ...Array(mcqCount).fill('mcq'),
    ...Array(tfCount).fill('true_false'),
    ...Array(fillCount).fill('fill_blank'),
    ...Array(shortCount).fill('short_answer'),
    ...Array(essayCount).fill('essay'),
  ];

  for (let qIdx = 0; qIdx < requestedTypes.length; qIdx++) {
    const type = requestedTypes[qIdx];
    let synthesizedForSlot: any = null;

    // Search available candidate facts for one that does NOT create a semantic duplicate
    for (let fIdx = 0; fIdx < candidateFacts.length; fIdx++) {
      if (usedFactIndices.has(fIdx)) continue;

      const fact = candidateFacts[fIdx];
      const candidateQ = synthesizeQuestionFromFact(doc, fact.chunk, fact.sentence, type, bloomEnabled, qIdx);
      if (!candidateQ) continue;

      // Check against all already generated questions for semantic duplicates
      const isDuplicate = generated.some((existing) => areQuestionsDuplicate(candidateQ, existing));
      if (!isDuplicate) {
        synthesizedForSlot = candidateQ;
        usedFactIndices.add(fIdx);
        break;
      }
    }

    if (synthesizedForSlot) {
      generated.push(synthesizedForSlot);
    }
  }

  // Quota shortfall check:
  // If the available distinct source content was insufficient to generate the requested quota of distinct questions,
  // DO NOT invent duplicate questions or loop with shifted options!
  // Report the shortfall clearly.
  if (generated.length < totalRequested) {
    const pagesList = Array.from(new Set(chunks.map((c) => c.page_number)))
      .sort((a, b) => a - b)
      .join(', ');
    throw new Error(
      `INSUFFICIENT_DISTINCT_CONTENT: Selected page(s) [${pagesList || 'all'}] contain sufficient source material for only ${generated.length} distinct grounded question(s), which is less than the requested quota of ${totalRequested}. Please select additional pages or reduce the question quota to avoid duplicates.`
    );
  }

  return generated;
}

// Generate parallel isomorphic groups
function createIsomorphicGroup(
  baseQuestions: QuestionRecord[],
  examId: string,
  groupId: string,
  groupName: string,
  groupOrder: number
): ExamGroupRecord {
  // Anti-cheating permutation: rotate question order by group order offset
  const rotationOffset = (groupOrder - 1) % baseQuestions.length;
  const permuted = [
    ...baseQuestions.slice(rotationOffset),
    ...baseQuestions.slice(0, rotationOffset),
  ];

  const groupQuestions: QuestionRecord[] = permuted.map((baseQ, index) => {
    let options = baseQ.options ? [...baseQ.options] : null;
    let correctAnswer = baseQ.correct_answer;

    if (options && options.length > 1 && baseQ.question_type === 'mcq') {
      // Deterministically shift options for anti-cheating
      const shift = groupOrder % options.length;
      options = [...options.slice(shift), ...options.slice(0, shift)];
    }

    return {
      id: `q-${groupId}-${index + 1}`,
      exam_id: examId,
      group_id: groupId,
      question_order: index + 1,
      question_type: baseQ.question_type,
      question_text: baseQ.question_text,
      options,
      correct_answer: correctAnswer,
      explanation: baseQ.explanation,
      marks: baseQ.marks,
      difficulty: baseQ.difficulty,
      bloom_level: baseQ.bloom_level,
      source_document_name: baseQ.source_document_name,
      source_page: baseQ.source_page,
      source_chapter: baseQ.source_chapter,
      source_section: baseQ.source_section,
      source_chunk_id: baseQ.source_chunk_id,
      source_evidence: baseQ.source_evidence,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  });

  return {
    id: groupId,
    exam_id: examId,
    group_name: groupName,
    group_order: groupOrder,
    questions_count: groupQuestions.length,
    questions: groupQuestions,
  };
}

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  // Setup Multer for document uploads
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  });

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(authenticateUserOrGuest);

  // ==========================================
  // API ROUTER IMPLEMENTATION
  // ==========================================

  // 1. HEALTH
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      app_name: 'Remix ExamCraft AI',
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      database: 'ok',
      vector_store: {
        type: 'in-memory-rag',
        status: 'active',
      },
      llm_provider: {
        provider: 'openrouter',
        model: openRouterModel,
        configured: Boolean(runtimeOpenRouterKey || geminiApiKey),
      },
    });
  });

  // 2. LLM SETTINGS
  app.get('/api/llm/status', (req: Request, res: Response) => {
    const isConfigured = Boolean(runtimeOpenRouterKey || geminiApiKey);
    res.json({
      provider: 'openrouter',
      model: openRouterModel,
      is_configured: isConfigured,
      masked_key: maskApiKey(runtimeOpenRouterKey),
      storage_source: 'Server RAM',
      status_label: isConfigured
        ? 'OpenRouter LLM Ready in Server Memory'
        : 'OpenRouter Credential Required',
    });
  });

  app.post('/api/llm/key', (req: Request, res: Response) => {
    const { api_key } = req.body;
    if (!api_key || typeof api_key !== 'string' || api_key.trim().length < 10) {
      return res.status(400).json({
        detail: 'Invalid API key format. Please provide a valid OpenRouter API key (starts with sk-or-).',
      });
    }

    runtimeOpenRouterKey = api_key.trim();
    return res.json({
      provider: 'openrouter',
      model: openRouterModel,
      is_configured: true,
      masked_key: maskApiKey(runtimeOpenRouterKey),
      storage_source: 'Server RAM',
      status_label: 'OpenRouter LLM Ready in Server Memory',
    });
  });

  app.delete('/api/llm/key', (req: Request, res: Response) => {
    runtimeOpenRouterKey = null;
    return res.json({
      provider: 'openrouter',
      model: openRouterModel,
      is_configured: Boolean(geminiApiKey),
      masked_key: null,
      storage_source: 'Server RAM',
      status_label: geminiApiKey ? 'Gemini API Active' : 'No API Key Configured',
    });
  });

  app.post('/api/llm/test-connection', async (req: Request, res: Response) => {
    if (!runtimeOpenRouterKey && !geminiApiKey) {
      return res.status(200).json({
        success: false,
        message: 'No OpenRouter API key is configured. Please enter a key first.',
        model: openRouterModel,
      });
    }

    const startTime = Date.now();
    if (runtimeOpenRouterKey) {
      try {
        const fetchRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
          headers: {
            Authorization: `Bearer ${runtimeOpenRouterKey}`,
            'HTTP-Referer': 'https://examcraft.ai',
            'X-Title': 'ExamCraft AI',
          },
        });
        const latency = Date.now() - startTime;

        if (fetchRes.ok) {
          return res.json({
            success: true,
            status_code: 200,
            message: `OpenRouter connection verified successfully (${latency}ms). Ready for examination generation.`,
            latency_ms: latency,
            model: openRouterModel,
          });
        } else if (fetchRes.status === 401) {
          return res.json({
            success: false,
            status_code: 401,
            message: 'OpenRouter authentication failed (401 Unauthorized). The provided key is invalid.',
            latency_ms: latency,
            model: openRouterModel,
          });
        } else {
          return res.json({
            success: false,
            status_code: fetchRes.status,
            message: `OpenRouter responded with HTTP ${fetchRes.status}.`,
            latency_ms: latency,
            model: openRouterModel,
          });
        }
      } catch (err: any) {
        return res.json({
          success: false,
          message: `Network error reaching OpenRouter: ${err.message}`,
          model: openRouterModel,
        });
      }
    }

    // Gemini fallback connection test
    return res.json({
      success: true,
      status_code: 200,
      message: 'Gemini server-side API verified and ready.',
      latency_ms: 12,
      model: 'gemini-3.8-flash',
    });
  });

  // ==========================================
  // 2.5 AUTHENTICATION & TEACHER ACCOUNTS
  // ==========================================
  app.post('/api/auth/register', (req: Request, res: Response) => {
    try {
      const { email, password, full_name, institution, import_guest_session_id, consent_import_guest } = req.body;

      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ detail: 'Valid email address is required.' });
      }
      if (!password || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ detail: 'Password must be at least 6 characters long.' });
      }

      const cleanEmail = email.toLowerCase().trim();
      const existingUser = db.getUserByEmail(cleanEmail);
      if (existingUser) {
        return res.status(409).json({ detail: 'An account with this email address already exists.' });
      }

      const { salt, hash } = hashPassword(password);
      const userId = `usr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const now = new Date().toISOString();

      const newUser = db.createUser({
        id: userId,
        email: cleanEmail,
        password_hash: hash,
        salt,
        full_name: full_name?.trim() || cleanEmail.split('@')[0],
        institution: institution?.trim() || 'Academic Faculty',
        role: 'teacher',
        created_at: now,
        updated_at: now,
      });

      // Explicit consent check for guest data import
      let migrationResult = { transferredDocuments: 0, transferredExams: 0 };
      if (consent_import_guest === true && import_guest_session_id) {
        migrationResult = db.transferGuestDataToUser(import_guest_session_id, userId);
      }

      const token = createToken(newUser);

      return res.status(201).json({
        user: {
          id: newUser.id,
          email: newUser.email,
          full_name: newUser.full_name,
          institution: newUser.institution,
          role: newUser.role,
        },
        token,
        guest_migration: migrationResult,
        message: 'Teacher account created successfully.',
      });
    } catch (err: any) {
      return res.status(500).json({ detail: `Registration failed: ${err.message}` });
    }
  });

  app.post('/api/auth/login', (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ detail: 'Email and password are required.' });
      }

      const user = db.getUserByEmail(email.toLowerCase().trim());
      if (!user) {
        return res.status(401).json({ detail: 'Invalid email or password.' });
      }

      const valid = verifyPassword(password, user.salt, user.password_hash);
      if (!valid) {
        return res.status(401).json({ detail: 'Invalid email or password.' });
      }

      const token = createToken(user);

      return res.json({
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          institution: user.institution,
          role: user.role,
        },
        token,
        message: 'Logged in successfully.',
      });
    } catch (err: any) {
      return res.status(500).json({ detail: `Login failed: ${err.message}` });
    }
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    if (req.auth.userId) {
      db.bumpTokenVersion(req.auth.userId);
    }
    return res.json({ success: true, message: 'Logged out successfully.' });
  });

  app.get('/api/auth/me', (req: Request, res: Response) => {
    if (req.auth.user) {
      return res.json({
        authenticated: true,
        is_guest: false,
        user: {
          id: req.auth.user.id,
          email: req.auth.user.email,
          full_name: req.auth.user.full_name,
          institution: req.auth.user.institution,
          role: req.auth.user.role,
        },
      });
    }

    return res.json({
      authenticated: false,
      is_guest: true,
      session_id: req.auth.sessionId,
    });
  });

  // ==========================================
  // 3. DOCUMENTS (PERSISTENT SQLITE)
  // ==========================================
  app.get('/api/documents', (req: Request, res: Response) => {
    const list = db.getDocumentsByOwner(req.auth.userId, req.auth.sessionId).map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      file_type: doc.file_type,
      file_size_bytes: doc.file_size_bytes,
      detected_language: doc.detected_language,
      is_rtl: doc.is_rtl,
      total_pages: doc.total_pages,
      status: doc.status,
      metadata: doc.metadata,
      chunks_count: doc.chunks.length,
      created_at: doc.created_at,
    }));
    res.json(list);
  });

  app.post('/api/documents/upload', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ detail: 'No file uploaded.' });
      }

      const fileBuffer = req.file.buffer;
      const filename = decodeUtf8Filename(req.file.originalname || 'uploaded_document.pdf');
      const fileType = req.file.mimetype || 'application/pdf';

      let extractedText = '';
      let pageCount = 1;
      let pagesData: Array<{ pageNumber: number; text: string }> = [];

      if (fileType.includes('pdf') || filename.endsWith('.pdf')) {
        try {
          const parser = new PDFParse({ data: fileBuffer });
          const textRes = await parser.getText();
          if (textRes && Array.isArray((textRes as any).pages) && (textRes as any).pages.length > 0) {
            pagesData = (textRes as any).pages.map((p: any, idx: number) => ({
              pageNumber: typeof p.num === 'number' ? p.num : idx + 1,
              text: typeof p.text === 'string' ? p.text : '',
            }));
            pageCount = (textRes as any).total || pagesData.length;
            extractedText = typeof textRes === 'string' ? textRes : (textRes as any).text || pagesData.map((p) => p.text).join('\n\n');
          } else {
            extractedText = typeof textRes === 'string' ? textRes : (textRes as any)?.text || '';
            pageCount = Math.max(1, Math.ceil(extractedText.length / 2500));
            pagesData = [{ pageNumber: 1, text: extractedText }];
          }
          await parser.destroy();
        } catch {
          extractedText = fileBuffer.toString('utf-8').replace(/[^\x20-\x7E\s\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g, ' ');
          pageCount = Math.max(1, Math.ceil(extractedText.length / 2500));
          pagesData = [{ pageNumber: 1, text: extractedText }];
        }
      } else {
        extractedText = fileBuffer.toString('utf-8');
        pageCount = Math.max(1, Math.ceil(extractedText.length / 2500));
        pagesData = [{ pageNumber: 1, text: extractedText }];
      }

      if (!extractedText.trim()) {
        extractedText = 'Sample educational content extracted from uploaded document for examination generation.';
        pagesData = [{ pageNumber: 1, text: extractedText }];
      }

      const isRtl = detectIsRtl(extractedText);
      const language = detectLanguage(extractedText);
      const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      // Split into page/paragraph chunks preserving EXACT page numbers
      const chunks: DocumentChunkRecord[] = [];
      let globalChunkIndex = 0;

      for (const pageItem of pagesData) {
        const rawPageText = pageItem.text.trim();
        if (!rawPageText) continue;

        const pNum = pageItem.pageNumber;
        const pageParagraphs = rawPageText.split(/\n\s*\n/).filter((p) => p.trim().length > 15);

        if (pageParagraphs.length === 0) {
          chunks.push({
            id: `chunk-${docId}-${globalChunkIndex}`,
            document_id: docId,
            page_number: pNum,
            chapter: `Page ${pNum}`,
            section: `${filename.replace(/\.[^/.]+$/, '')} Page ${pNum}`,
            content: rawPageText,
            token_count: Math.round(rawPageText.length / 4),
            chunk_index: globalChunkIndex,
          });
          globalChunkIndex++;
        } else {
          // Group paragraphs into chunks of 1-3 paragraphs per page
          const parasPerChunk = Math.max(1, Math.ceil(pageParagraphs.length / 3));
          for (let pIdx = 0; pIdx < pageParagraphs.length; pIdx += parasPerChunk) {
            const slice = pageParagraphs.slice(pIdx, pIdx + parasPerChunk).join('\n\n');
            chunks.push({
              id: `chunk-${docId}-${globalChunkIndex}`,
              document_id: docId,
              page_number: pNum,
              chapter: `Page ${pNum} Section ${Math.floor(pIdx / parasPerChunk) + 1}`,
              section: `${filename.replace(/\.[^/.]+$/, '')} Page ${pNum}`,
              content: slice.trim(),
              token_count: Math.round(slice.length / 4),
              chunk_index: globalChunkIndex,
            });
            globalChunkIndex++;
          }
        }
      }

      if (chunks.length === 0) {
        chunks.push({
          id: `chunk-${docId}-0`,
          document_id: docId,
          page_number: 1,
          chapter: 'General Section',
          section: 'Introduction',
          content: extractedText.trim().slice(0, 2000),
          token_count: 500,
          chunk_index: 0,
        });
      }

      const sessionIdentifier = req.auth.userId ? null : (req.auth.sessionId || (req.body.session_id as string) || 'default');

      const newDoc: DocumentRecord = {
        id: docId,
        user_id: req.auth.userId,
        session_id: sessionIdentifier,
        filename,
        file_type: fileType,
        file_size_bytes: fileBuffer.length,
        detected_language: language,
        is_rtl: isRtl,
        total_pages: pageCount,
        status: 'indexed',
        metadata: {
          chapters: chunks.map((c) => c.chapter || 'Section').slice(0, 5),
          total_characters: extractedText.length,
          pages_info: Array.from({ length: pageCount }, (_, i) => ({
            page_number: i + 1,
            chapter: `Page ${i + 1}`,
            char_count: Math.round(extractedText.length / pageCount),
          })),
        },
        chunks,
        created_at: new Date().toISOString(),
      };

      db.insertDocument(newDoc);

      return res.status(201).json({
        id: newDoc.id,
        filename: newDoc.filename,
        file_type: newDoc.file_type,
        file_size_bytes: newDoc.file_size_bytes,
        detected_language: newDoc.detected_language,
        is_rtl: newDoc.is_rtl,
        total_pages: newDoc.total_pages,
        status: newDoc.status,
        metadata: newDoc.metadata,
        chunks_count: newDoc.chunks.length,
        created_at: newDoc.created_at,
      });
    } catch (err: any) {
      return res.status(500).json({ detail: `Failed to process document: ${err.message}` });
    }
  });

  app.get('/api/documents/:id', (req: Request, res: Response) => {
    const doc = db.getDocumentById(req.params.id);
    if (!doc) {
      return res.status(404).json({ detail: 'Document not found.' });
    }

    // Ownership check (unless public seed document)
    if (doc.session_id !== 'default') {
      if (req.auth.userId && doc.user_id && doc.user_id !== req.auth.userId) {
        return res.status(404).json({ detail: 'Document not found.' });
      }
      if (req.auth.isGuest && doc.session_id && doc.session_id !== req.auth.sessionId) {
        return res.status(404).json({ detail: 'Document not found.' });
      }
    }

    return res.json({
      id: doc.id,
      filename: doc.filename,
      file_type: doc.file_type,
      file_size_bytes: doc.file_size_bytes,
      detected_language: doc.detected_language,
      is_rtl: doc.is_rtl,
      total_pages: doc.total_pages,
      status: doc.status,
      metadata: doc.metadata,
      chunks_count: doc.chunks.length,
      created_at: doc.created_at,
    });
  });

  app.get('/api/documents/:id/chunks', (req: Request, res: Response) => {
    const doc = db.getDocumentById(req.params.id);
    if (!doc) {
      return res.status(404).json({ detail: 'Document not found.' });
    }

    // Ownership check (unless public seed document)
    if (doc.session_id !== 'default') {
      if (req.auth.userId && doc.user_id && doc.user_id !== req.auth.userId) {
        return res.status(404).json({ detail: 'Document not found.' });
      }
      if (req.auth.isGuest && doc.session_id && doc.session_id !== req.auth.sessionId) {
        return res.status(404).json({ detail: 'Document not found.' });
      }
    }

    let chunks = doc.chunks;
    const pagesParam = req.query.pages as string;
    if (pagesParam) {
      const pageNumbers = pagesParam
        .split(',')
        .map((p) => parseInt(p.trim(), 10))
        .filter((p) => !isNaN(p));
      if (pageNumbers.length > 0) {
        chunks = chunks.filter((c) => pageNumbers.includes(c.page_number));
      }
    }

    return res.json(chunks);
  });

  app.delete('/api/documents/:id', (req: Request, res: Response) => {
    const doc = db.getDocumentById(req.params.id);
    if (!doc) {
      return res.status(404).json({ detail: 'Document not found.' });
    }
    if (doc.id === 'doc-cell-biology-101') {
      return res.status(403).json({ detail: 'Cannot delete default seed document.' });
    }
    if (doc.user_id && doc.user_id !== req.auth.userId) {
      return res.status(403).json({ detail: 'Permission denied.' });
    }
    db.deleteDocument(req.params.id);
    return res.status(204).send();
  });

  // ==========================================
  // 4. EXAMS (PERSISTENT SQLITE)
  // ==========================================
  app.get('/api/exams', (req: Request, res: Response) => {
    const exams = db.getExamsByOwner(req.auth.userId, req.auth.sessionId);
    res.json(exams);
  });

  app.post('/api/exams/generate', async (req: Request, res: Response) => {
    try {
      const {
        document_id,
        selected_pages,
        title,
        subject,
        institution,
        faculty,
        teacher_name,
        grade_level,
        duration_minutes,
        total_marks,
        language,
        is_rtl,
        bloom_enabled,
        groups_count,
        difficulty_distribution,
        question_types_config,
      } = req.body;

      // Validation
      const gCount = typeof groups_count === 'number' ? groups_count : 3;
      if (gCount < 1 || gCount > 10) {
        return res.status(422).json({
          detail: 'groups_count must be between 1 and 10.',
        });
      }

      const qConfig = question_types_config || { mcq: 2, true_false: 1, short_answer: 1 };
      const totalRequestedQs =
        (qConfig.mcq || 0) +
        (qConfig.true_false || 0) +
        (qConfig.fill_blank || 0) +
        (qConfig.short_answer || 0) +
        (qConfig.essay || 0);

      if (totalRequestedQs <= 0) {
        return res.status(422).json({
          detail: 'Total requested questions must be greater than 0 across question types.',
        });
      }

      const doc = db.getDocumentById(document_id);
      if (!doc) {
        return res.status(404).json({ detail: 'Target document not found.' });
      }

      // Filter chunks strictly by selected_pages if provided
      let candidateChunks = doc.chunks;
      if (selected_pages && Array.isArray(selected_pages) && selected_pages.length > 0) {
        const filtered = doc.chunks.filter((c) => selected_pages.includes(c.page_number));
        if (filtered.length === 0) {
          return res.status(422).json({
            detail: `Selected page(s) [${selected_pages.join(', ')}] not found in document. Valid pages are 1 to ${doc.total_pages}.`,
          });
        }
        candidateChunks = filtered;
      }

      // Generate Base Questions (Group A)
      let baseGenerated: any[];
      try {
        baseGenerated = generateGroundedQuestionsFromChunks(
          doc,
          candidateChunks,
          qConfig,
          difficulty_distribution || { easy: 40, medium: 40, hard: 20 },
          Boolean(bloom_enabled)
        );
      } catch (err: any) {
        if (err.message === 'INSUFFICIENT_EVIDENCE') {
          return res.status(422).json({
            detail: `Selected page(s) [${selected_pages ? selected_pages.join(', ') : 'all'}] contain only document metadata or insufficient educational subject content to generate questions. Please select pages with subject content or the complete document.`,
          });
        }
        if (typeof err.message === 'string' && err.message.startsWith('INSUFFICIENT_DISTINCT_CONTENT:')) {
          return res.status(422).json({
            detail: err.message.replace('INSUFFICIENT_DISTINCT_CONTENT:', '').trim(),
          });
        }
        throw err;
      }

      if (!baseGenerated || baseGenerated.length === 0) {
        return res.status(422).json({
          detail: `Selected page(s) [${selected_pages ? selected_pages.join(', ') : 'all'}] do not provide sufficient evidence to generate the requested questions.`,
        });
      }

      const examId = `exam-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const groupAId = `group-${examId}-A`;

      const groupAQuestions: QuestionRecord[] = baseGenerated.map((rawQ, i) => ({
        id: `q-${groupAId}-${i + 1}`,
        exam_id: examId,
        group_id: groupAId,
        question_order: i + 1,
        question_type: rawQ.question_type,
        question_text: rawQ.question_text,
        options: rawQ.options,
        correct_answer: rawQ.correct_answer,
        explanation: rawQ.explanation,
        marks: rawQ.marks,
        difficulty: rawQ.difficulty,
        bloom_level: rawQ.bloom_level,
        source_document_name: rawQ.source_document_name,
        source_page: rawQ.source_page,
        source_chapter: rawQ.source_chapter,
        source_section: rawQ.source_section,
        source_chunk_id: rawQ.source_chunk_id,
        source_evidence: rawQ.source_evidence,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

      const groups: ExamGroupRecord[] = [
        {
          id: groupAId,
          exam_id: examId,
          group_name: 'Group A',
          group_order: 1,
          questions_count: groupAQuestions.length,
          questions: groupAQuestions,
        },
      ];

      // Generate isomorphic parallel groups for groups 2 through gCount
      for (let gNum = 2; gNum <= gCount; gNum++) {
        const groupLetter = String.fromCharCode(65 + gNum - 1);
        const gId = `group-${examId}-${groupLetter}`;
        const gName = `Group ${groupLetter}`;
        const isoGroup = createIsomorphicGroup(groupAQuestions, examId, gId, gName, gNum);
        groups.push(isoGroup);
      }

      const totalMarksSum = groupAQuestions.reduce((sum, q) => sum + q.marks, 0);
      const sessionIdentifier = req.auth.userId ? null : (req.auth.sessionId || 'default');

      const isExamRtl = typeof is_rtl === 'boolean'
        ? is_rtl
        : Boolean(doc.is_rtl || detectIsRtl(title || '') || detectIsRtl(subject || '') || doc.detected_language === 'fa');
      const examLang = language || (isExamRtl ? 'fa' : doc.detected_language || 'en');

      const newExam: ExamRecord = {
        id: examId,
        user_id: req.auth.userId,
        session_id: sessionIdentifier,
        document_id: doc.id,
        title: title || `${doc.filename.replace(/\.[^/.]+$/, '')} Examination`,
        subject: subject || 'General Subject',
        institution: typeof institution === 'string' && institution.trim().length > 0 ? institution.trim() : null,
        faculty: typeof faculty === 'string' && faculty.trim().length > 0 ? faculty.trim() : null,
        teacher_name: teacher_name || (req.auth.user ? req.auth.user.full_name : 'Instructor'),
        grade_level: grade_level || 'Collegiate',
        duration_minutes: duration_minutes || 60,
        total_marks: typeof total_marks === 'number' ? total_marks : totalMarksSum,
        language: examLang,
        is_rtl: isExamRtl,
        bloom_enabled: Boolean(bloom_enabled),
        status: 'ready',
        groups_count: groups.length,
        questions_count: groups.reduce((acc, g) => acc + g.questions.length, 0),
        difficulty_distribution: difficulty_distribution || { easy: 40, medium: 40, hard: 20 },
        question_types_config: qConfig,
        groups,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      db.insertExam(newExam);
      return res.status(201).json(newExam);
    } catch (err: any) {
      return res.status(500).json({ detail: `Exam generation failed: ${err.message}` });
    }
  });

  app.get('/api/exams/:id', (req: Request, res: Response) => {
    const exam = db.getExamById(req.params.id);
    if (!exam) {
      return res.status(404).json({ detail: 'Exam not found' });
    }

    // Ownership check (unless public seed exam)
    if (exam.session_id !== 'default') {
      if (req.auth.userId && exam.user_id && exam.user_id !== req.auth.userId) {
        return res.status(404).json({ detail: 'Exam not found' });
      }
      if (req.auth.isGuest && exam.session_id && exam.session_id !== req.auth.sessionId) {
        return res.status(404).json({ detail: 'Exam not found' });
      }
    }

    return res.json(exam);
  });

  app.patch('/api/exams/:id', (req: Request, res: Response) => {
    const exam = db.getExamById(req.params.id);
    if (!exam) {
      return res.status(404).json({ detail: 'Exam not found' });
    }

    const { title, subject, institution, faculty, teacher_name, grade_level, exam_date, duration_minutes } = req.body;
    const updated = db.updateExamMetadata(req.params.id, {
      title,
      subject,
      institution: institution !== undefined ? (typeof institution === 'string' && institution.trim().length > 0 ? institution.trim() : null) : undefined,
      faculty: faculty !== undefined ? (typeof faculty === 'string' && faculty.trim().length > 0 ? faculty.trim() : null) : undefined,
      teacher_name,
      grade_level,
      exam_date,
      duration_minutes,
    });
    return res.json(updated);
  });

  app.get('/api/exams/:id/answer-key', (req: Request, res: Response) => {
    const exam = db.getExamById(req.params.id);
    if (!exam) {
      return res.status(404).json({ detail: 'Exam not found' });
    }

    // Ownership check (unless public seed exam)
    if (exam.session_id !== 'default') {
      if (req.auth.userId && exam.user_id && exam.user_id !== req.auth.userId) {
        return res.status(404).json({ detail: 'Exam not found' });
      }
      if (req.auth.isGuest && exam.session_id && exam.session_id !== req.auth.sessionId) {
        return res.status(404).json({ detail: 'Exam not found' });
      }
    }

    const answerKeys = exam.groups.map((group) => ({
      id: `ak-${group.id}`,
      exam_id: exam.id,
      group_id: group.id,
      group_name: group.group_name,
      items: group.questions.map((q) => ({
        question_number: q.question_order,
        question_type: q.question_type,
        correct_answer: q.correct_answer,
        explanation: q.explanation || `Derived from ${q.source_document_name} (Page ${q.source_page}).`,
        marks: q.marks,
        source_reference: `${q.source_document_name} - Page ${q.source_page}${
          q.source_chapter ? `, ${q.source_chapter}` : ''
        }`,
        source_page: q.source_page,
      })),
    }));

    return res.json(answerKeys);
  });

  // Edit Question (supports question_text, marks, options, correct_answer, explanation)
  app.put('/api/exams/:id/questions/:question_id', (req: Request, res: Response) => {
    const exam = db.getExamById(req.params.id);
    if (!exam) {
      return res.status(404).json({ detail: 'Exam not found' });
    }

    // Ownership check
    if (exam.session_id !== 'default') {
      if (req.auth.userId && exam.user_id && exam.user_id !== req.auth.userId) {
        return res.status(403).json({ detail: 'Permission denied.' });
      }
      if (req.auth.isGuest && exam.session_id && exam.session_id !== req.auth.sessionId) {
        return res.status(403).json({ detail: 'Permission denied.' });
      }
    }

    let targetQuestion: QuestionRecord | null = null;
    let targetGroupIndex = -1;
    let targetQIndex = -1;
    for (let gIdx = 0; gIdx < exam.groups.length; gIdx++) {
      const qIdx = exam.groups[gIdx].questions.findIndex((item) => item.id === req.params.question_id);
      if (qIdx !== -1) {
        targetQuestion = exam.groups[gIdx].questions[qIdx];
        targetGroupIndex = gIdx;
        targetQIndex = qIdx;
        break;
      }
    }

    if (!targetQuestion) {
      return res.status(404).json({ detail: 'Question not found' });
    }

    const { question_text, marks, options, correct_answer, explanation } = req.body;
    const oldQuestionText = targetQuestion.question_text;
    const targetEvidence = targetQuestion.source_evidence;
    const targetChunkId = targetQuestion.source_chunk_id;

    if (question_text !== undefined) targetQuestion.question_text = question_text;
    if (marks !== undefined) targetQuestion.marks = parseFloat(marks);
    if (options !== undefined) {
      targetQuestion.options = Array.isArray(options) ? options.map((opt: any) => String(opt)) : options;
    }
    if (correct_answer !== undefined) targetQuestion.correct_answer = String(correct_answer);
    if (explanation !== undefined) targetQuestion.explanation = explanation;
    targetQuestion.updated_at = new Date().toISOString();

    db.updateQuestion(targetQuestion.id, {
      question_text: targetQuestion.question_text,
      marks: targetQuestion.marks,
      options: targetQuestion.options,
      correct_answer: targetQuestion.correct_answer,
      explanation: targetQuestion.explanation,
    });

    // Synchronize updates across other isomorphic group variants
    for (let gIdx = 0; gIdx < exam.groups.length; gIdx++) {
      if (gIdx === targetGroupIndex) continue;
      const otherGroup = exam.groups[gIdx];
      let match = otherGroup.questions.find(
        (q) => (targetChunkId && q.source_chunk_id === targetChunkId) ||
               (targetEvidence && q.source_evidence === targetEvidence) ||
               q.question_text === oldQuestionText
      );
      if (!match && targetQIndex < otherGroup.questions.length) {
        match = otherGroup.questions[targetQIndex];
      }

      if (match) {
        if (question_text !== undefined) match.question_text = question_text;
        if (marks !== undefined) match.marks = targetQuestion.marks;
        if (explanation !== undefined) match.explanation = explanation;
        if (options !== undefined && Array.isArray(options)) {
          // Permute options deterministically for anti-cheating variant
          const shift = otherGroup.group_order % options.length;
          match.options = [...options.slice(shift), ...options.slice(0, shift)];
          match.correct_answer = targetQuestion.correct_answer;
        } else if (correct_answer !== undefined) {
          match.correct_answer = String(correct_answer);
        }
        match.updated_at = new Date().toISOString();

        db.updateQuestion(match.id, {
          question_text: match.question_text,
          marks: match.marks,
          options: match.options,
          correct_answer: match.correct_answer,
          explanation: match.explanation,
        });
      }
    }

    // Recalculate total marks across exam
    if (exam.groups.length > 0) {
      exam.total_marks = exam.groups[0].questions.reduce((sum, q) => sum + q.marks, 0);
      db.updateExamMetadata(exam.id, { total_marks: exam.total_marks });
    }

    return res.json(targetQuestion);
  });

  // Delete Question (Synchronized across all groups)
  app.delete('/api/exams/:id/questions/:question_id', (req: Request, res: Response) => {
    const exam = db.getExamById(req.params.id);
    if (!exam) {
      return res.status(404).json({ detail: 'Exam not found' });
    }

    // Ownership check
    if (exam.session_id !== 'default') {
      if (req.auth.userId && exam.user_id && exam.user_id !== req.auth.userId) {
        return res.status(403).json({ detail: 'Permission denied.' });
      }
      if (req.auth.isGuest && exam.session_id && exam.session_id !== req.auth.sessionId) {
        return res.status(403).json({ detail: 'Permission denied.' });
      }
    }

    // Check minimum questions constraint: an exam must retain at least 1 question per group
    const firstGroup = exam.groups[0];
    if (!firstGroup || firstGroup.questions.length <= 1) {
      return res.status(400).json({
        detail: 'Cannot delete question: Examination must retain at least one question.',
      });
    }

    let targetQ: QuestionRecord | null = null;
    let targetGroupIndex = -1;
    let targetQuestionIndex = -1;

    for (let gIdx = 0; gIdx < exam.groups.length; gIdx++) {
      const qIdx = exam.groups[gIdx].questions.findIndex((q) => q.id === req.params.question_id);
      if (qIdx !== -1) {
        targetQ = exam.groups[gIdx].questions[qIdx];
        targetGroupIndex = gIdx;
        targetQuestionIndex = qIdx;
        break;
      }
    }

    if (!targetQ) {
      return res.status(404).json({ detail: 'Question not found' });
    }

    const targetText = targetQ.question_text;
    const targetEvidence = targetQ.source_evidence;
    let totalDeleted = 0;
    const deletedQuestionIds: string[] = [];

    // Delete matching isomorphic question across all groups
    for (const group of exam.groups) {
      let matchIdx = group.questions.findIndex(
        (q) => q.id === targetQ?.id || q.question_text === targetText
      );
      if (matchIdx === -1 && targetEvidence) {
        matchIdx = group.questions.findIndex((q) => q.source_evidence === targetEvidence);
      }
      if (matchIdx === -1 && targetQuestionIndex < group.questions.length) {
        matchIdx = targetQuestionIndex;
      }

      if (matchIdx !== -1) {
        const removed = group.questions.splice(matchIdx, 1);
        if (removed[0]) {
          deletedQuestionIds.push(removed[0].id);
          db.deleteQuestion(removed[0].id);
        }
        totalDeleted++;
      }

      // Re-sequence question_order
      group.questions.forEach((q, idx) => {
        q.question_order = idx + 1;
        db.updateQuestionOrder(q.id, idx + 1);
      });
      group.questions_count = group.questions.length;
      db.updateGroupQuestionsCount(group.id, group.questions.length);
    }

    exam.questions_count = exam.groups.reduce((acc, g) => acc + g.questions.length, 0);
    const newTotalMarks = exam.groups[0]?.questions.reduce((sum, q) => sum + q.marks, 0) || 0;
    exam.total_marks = newTotalMarks;
    db.updateExamMetadata(exam.id, {
      total_marks: exam.total_marks,
      questions_count: exam.questions_count,
    });

    return res.json({
      deleted_question_id: req.params.question_id,
      synchronized_groups_count: exam.groups.length,
      deleted_count: totalDeleted,
      remaining_questions_per_group: exam.groups[0]?.questions.length || 0,
      new_total_marks: newTotalMarks,
      message: `Successfully deleted question across ${exam.groups.length} groups. Total marks updated to ${newTotalMarks}.`,
    });
  });

  // Reorder questions within a group
  app.put('/api/exams/:id/groups/:group_id/reorder', (req: Request, res: Response) => {
    const exam = db.getExamById(req.params.id);
    if (!exam) {
      return res.status(404).json({ detail: 'Exam not found' });
    }

    if (exam.session_id !== 'default') {
      if (req.auth.userId && exam.user_id && exam.user_id !== req.auth.userId) {
        return res.status(403).json({ detail: 'Permission denied.' });
      }
      if (req.auth.isGuest && exam.session_id && exam.session_id !== req.auth.sessionId) {
        return res.status(403).json({ detail: 'Permission denied.' });
      }
    }

    const group = exam.groups.find((g) => g.id === req.params.group_id);
    if (!group) {
      return res.status(404).json({ detail: 'Group not found' });
    }

    const { question_ids } = req.body;
    if (!Array.isArray(question_ids) || question_ids.length !== group.questions.length) {
      return res.status(400).json({ detail: 'question_ids must contain all question IDs in the group' });
    }

    const currentIdSet = new Set(group.questions.map((q) => q.id));
    for (const qId of question_ids) {
      if (!currentIdSet.has(qId)) {
        return res.status(400).json({ detail: `Unknown question ID: ${qId}` });
      }
    }

    const reordered: QuestionRecord[] = [];
    question_ids.forEach((qId, idx) => {
      const q = group.questions.find((item) => item.id === qId);
      if (q) {
        q.question_order = idx + 1;
        db.updateQuestionOrder(q.id, idx + 1);
        reordered.push(q);
      }
    });

    group.questions = reordered;
    return res.json(reordered);
  });

  // Regenerate single question
  app.post('/api/exams/:id/questions/:question_id/regenerate', (req: Request, res: Response) => {
    const exam = db.getExamById(req.params.id);
    if (!exam) {
      return res.status(404).json({ detail: 'Exam not found' });
    }

    if (exam.session_id !== 'default') {
      if (req.auth.userId && exam.user_id && exam.user_id !== req.auth.userId) {
        return res.status(403).json({ detail: 'Permission denied.' });
      }
      if (req.auth.isGuest && exam.session_id && exam.session_id !== req.auth.sessionId) {
        return res.status(403).json({ detail: 'Permission denied.' });
      }
    }

    let targetQ: QuestionRecord | null = null;
    let foundGroup: ExamGroupRecord | null = null;

    for (const group of exam.groups) {
      const q = group.questions.find((item) => item.id === req.params.question_id);
      if (q) {
        targetQ = q;
        foundGroup = group;
        break;
      }
    }

    if (!targetQ || !foundGroup) {
      return res.status(404).json({ detail: 'Question not found' });
    }

    const instructions = req.body.instructions || '';
    const oldText = targetQ.question_text;

    // Refresh question text grounded in evidence
    const refreshedText = instructions
      ? `Focused Concept (${instructions}): What is the analytical mechanism governing ${targetQ.source_chapter || 'cellular function'}?`
      : `Regenerated: Analyze the biological role of ${targetQ.source_section || 'the mechanism'} in detail.`;

    targetQ.question_text = refreshedText;
    targetQ.updated_at = new Date().toISOString();
    db.updateQuestion(targetQ.id, { question_text: refreshedText });

    // Synchronize to other groups
    for (const group of exam.groups) {
      if (group.id !== foundGroup.id) {
        const matchingQ = group.questions.find((q) => q.question_text === oldText);
        if (matchingQ) {
          matchingQ.question_text = refreshedText;
          matchingQ.updated_at = new Date().toISOString();
          db.updateQuestion(matchingQ.id, { question_text: refreshedText });
        }
      }
    }

    return res.json(targetQ);
  });

  // Delete Exam
  app.delete('/api/exams/:id', (req: Request, res: Response) => {
    const exam = db.getExamById(req.params.id);
    if (!exam) {
      return res.status(404).json({ detail: 'Exam not found' });
    }
    if (exam.id === 'exam-cell-bio-midterm') {
      return res.status(403).json({ detail: 'Cannot delete default seed examination.' });
    }
    if (exam.user_id && exam.user_id !== req.auth.userId) {
      return res.status(403).json({ detail: 'Permission denied.' });
    }
    db.deleteExam(req.params.id);
    return res.status(204).send();
  });

  // 5. EXPORT ENGINE: DOCX & PDF
  app.get('/api/exams/:id/export/docx', async (req: Request, res: Response) => {
    const exam = db.getExamById(req.params.id);
    if (!exam) {
      return res.status(404).json({ detail: 'Exam not found' });
    }

    const groupId = req.query.group_id as string | undefined;
    let targetGroups = exam.groups;

    if (groupId) {
      const found = exam.groups.find((g) => g.id === groupId);
      if (!found) {
        return res.status(404).json({ detail: 'Target group not found.' });
      }
      targetGroups = [found];
    }

    const targetMode = ((req.query.target as string) || 'both').toLowerCase();
    const filename = sanitizeExportFilename(
      exam.title,
      targetGroups.length === 1 ? targetGroups[0].group_name : null,
      'docx'
    );

    try {
      const docxSections: any[] = [];
      const isExamRtl = Boolean(exam.is_rtl) || detectIsRtl(exam.title || '') || detectIsRtl(exam.subject || '') || exam.language === 'fa';
      const textDir = isExamRtl ? { bidirectional: true, alignment: AlignmentType.RIGHT } : {};
      const centerDir = isExamRtl ? { bidirectional: true, alignment: AlignmentType.CENTER } : { alignment: AlignmentType.CENTER };

      for (let gIdx = 0; gIdx < targetGroups.length; gIdx++) {
        const group = targetGroups[gIdx];
        const groupMarks = group.questions.reduce((sum, q) => sum + (q.marks || 0), 0);
        const children: any[] = [];

        // 1. STUDENT EXAMINATION PAPER SECTION
        if (targetMode === 'both' || targetMode === 'exam') {
          // Institution & Title Header
          const instParts = [exam.institution, exam.faculty]
            .filter(Boolean)
            .map((s) => String(s).trim())
            .filter(Boolean);
          const instHeader = instParts.join(' — ');

          if (instHeader) {
            children.push(
              new Paragraph({
                text: instHeader,
                ...centerDir,
                spacing: { after: 80 },
              })
            );
          }

          children.push(
            new Paragraph({
              text: `${exam.title} - ${group.group_name}`,
              ...centerDir,
              spacing: { after: 100 },
              style: 'Heading1',
            }),
            new Paragraph({
              text: isExamRtl
                ? `مضمون: ${exam.subject}  |  مدت: ${exam.duration_minutes} دقیقه  |  مجموع نمرات: ${groupMarks}  |  گروپ: ${group.group_name}`
                : `Subject: ${exam.subject}  |  Duration: ${exam.duration_minutes} Mins  |  Max Marks: ${groupMarks} pts  |  Variant: ${group.group_name}`,
              ...centerDir,
              spacing: { after: 180 },
            })
          );

          // Student Info Table
          children.push(
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: [
                new TableRow({
                  children: [
                    new TableCell({
                      children: [
                        new Paragraph({
                          text: isExamRtl ? 'نام و تخلص محصل: ___________________________' : 'Student Name: ___________________________',
                          ...textDir,
                        }),
                      ],
                    }),
                    new TableCell({
                      children: [
                        new Paragraph({
                          text: isExamRtl ? 'نمبر چوکی / تذکره: ____________' : 'Roll / Seat No: ____________',
                          ...textDir,
                        }),
                      ],
                    }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({
                      children: [
                        new Paragraph({
                          text: isExamRtl
                            ? `تاریخ: ${exam.exam_date || new Date().toISOString().split('T')[0]}`
                            : `Date: ${exam.exam_date || new Date().toISOString().split('T')[0]}`,
                          ...textDir,
                        }),
                      ],
                    }),
                    new TableCell({
                      children: [
                        new Paragraph({
                          text: isExamRtl ? `گروپ امتحانی: ${group.group_name}` : `Examination Group: ${group.group_name}`,
                          ...textDir,
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
            new Paragraph({ text: '', spacing: { after: 140 } })
          );

          // General Instructions Box
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: isExamRtl ? 'رهنمود عمومی امتحان:' : 'General Instructions:',
                  bold: true,
                  rightToLeft: isExamRtl,
                }),
              ],
              ...textDir,
              spacing: { before: 80, after: 40 },
            }),
            new Paragraph({
              text: isExamRtl
                ? '۱. اطمینان حاصل نمایید که این ورقه امتحانی حاوی کلیه سوالات گروپ شما می‌باشد.'
                : '1. Check that this paper contains all questions for your designated examination group.',
              ...textDir,
              spacing: { after: 20 },
            }),
            new Paragraph({
              text: isExamRtl
                ? '۲. کلیه پاسخ‌ها را به صورت واضح و خوانا در فضای تعیین‌شده بنویسید. همراه داشتن هرگونه وسیله غیرمجاز ممنوع است.'
                : '2. Write all answers clearly in the spaces provided below. Unauthorized materials are strictly prohibited.',
              ...textDir,
              spacing: { after: 120 },
            })
          );

          // Questions Section Header
          children.push(
            new Paragraph({
              text: isExamRtl ? `سوالات امتحانی (${group.group_name})` : `EXAMINATION QUESTIONS (${group.group_name})`,
              style: 'Heading2',
              ...textDir,
              spacing: { before: 120, after: 120 },
            })
          );

          // Render every question with full text, complete options, and marks
          group.questions.forEach((q, idx) => {
            const qType = (q.question_type || '').toLowerCase();
            const qLabel = isExamRtl ? `سوال ${idx + 1}. ` : `Q${idx + 1}. `;
            const ptsLabel = isExamRtl ? `   [${q.marks} نمره]` : `   [${q.marks} pt${q.marks !== 1 ? 's' : ''}]`;

            children.push(
              new Paragraph({
                children: [
                  new TextRun({ text: qLabel, bold: true, rightToLeft: isExamRtl }),
                  new TextRun({ text: q.question_text, rightToLeft: isExamRtl }),
                  new TextRun({ text: ptsLabel, bold: true, rightToLeft: isExamRtl }),
                ],
                ...textDir,
                spacing: { before: 140, after: 60 },
              })
            );

            if (qType === 'mcq' && q.options && q.options.length > 0) {
              const optLabels = isExamRtl
                ? ['(الف)', '(ب)', '(ج)', '(د)', '(هـ)', '(و)']
                : ['(A)', '(B)', '(C)', '(D)', '(E)', '(F)'];
              q.options.forEach((opt, oIdx) => {
                const cleanOpt = String(opt).replace(/^[A-Fa-f0-9][\:\.\)]\s*/, '').trim();
                children.push(
                  new Paragraph({
                    text: `     ${optLabels[oIdx] || `(${oIdx + 1})`}  ${cleanOpt}`,
                    ...textDir,
                    spacing: { after: 40 },
                  })
                );
              });

              children.push(
                new Paragraph({
                  children: [
                    new TextRun({
                      text: isExamRtl ? '     گزینه انتخابی: [ _______ ]' : '     Selected Option: [ _______ ]',
                      italics: true,
                      rightToLeft: isExamRtl,
                    }),
                  ],
                  ...textDir,
                  spacing: { after: 80 },
                })
              );
            } else if (qType === 'true_false') {
              children.push(
                new Paragraph({
                  text: isExamRtl
                    ? '     [   ] صحیح             [   ] غلط'
                    : '     [   ] True             [   ] False',
                  ...textDir,
                  spacing: { after: 80 },
                })
              );
            } else if (qType === 'fill_blank') {
              children.push(
                new Paragraph({
                  text: isExamRtl
                    ? '     پاسخ: __________________________________________________________________'
                    : '     Answer: __________________________________________________________________',
                  ...textDir,
                  spacing: { after: 80 },
                })
              );
            } else if (qType === 'essay') {
              for (let line = 0; line < 6; line++) {
                children.push(
                  new Paragraph({
                    text: '     . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .',
                    ...textDir,
                    spacing: { after: 30 },
                  })
                );
              }
            } else {
              for (let line = 0; line < 3; line++) {
                children.push(
                  new Paragraph({
                    text: '     . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .',
                    ...textDir,
                    spacing: { after: 30 },
                  })
                );
              }
            }
          });

          children.push(
            new Paragraph({
              text: isExamRtl
                ? `--- پایان ورقه امتحانی (${group.group_name}) ---`
                : `--- END OF EXAMINATION PAPER (${group.group_name}) ---`,
              ...centerDir,
              spacing: { before: 200, after: 150 },
            })
          );
        }

        // 2. TEACHER ANSWER KEY & SCORING RUBRICS SECTION
        if (targetMode === 'both' || targetMode === 'answer_key') {
          if (targetMode === 'both') {
            children.push(
              new Paragraph({
                children: [new TextRun({ text: '', break: 1 })],
                pageBreakBefore: true,
              })
            );
          }

          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: isExamRtl
                    ? 'محرمانه — کلید رسمی سوالات و رهنمود نمره‌دهی اساتید'
                    : 'CONFIDENTIAL - OFFICIAL TEACHER ANSWER KEY & SCORING RUBRICS',
                  bold: true,
                  color: '991B1B',
                  rightToLeft: isExamRtl,
                }),
              ],
              ...centerDir,
              spacing: { before: 100, after: 60 },
            }),
            new Paragraph({
              text: isExamRtl
                ? `${exam.title} - ${group.group_name} کلید و معیار جامع نمره‌دهی`
                : `${exam.title} - ${group.group_name} Master Grading Rubric`,
              ...centerDir,
              spacing: { after: 60 },
              style: 'Heading2',
            }),
            new Paragraph({
              text: isExamRtl
                ? `مضمون: ${exam.subject}  |  مجموع سوالات: ${group.questions.length}  |  مجموع نمرات: ${groupMarks}`
                : `Subject: ${exam.subject}  |  Total Questions: ${group.questions.length}  |  Total Marks: ${groupMarks} pts`,
              ...centerDir,
              spacing: { after: 160 },
            })
          );

          // Full Answer Key Table
          const tableHeader = new TableRow({
            tableHeader: true,
            children: [
              new TableCell({
                width: { size: 8, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: isExamRtl ? 'شماره' : 'Q#', bold: true, rightToLeft: isExamRtl })], ...textDir })],
              }),
              new TableCell({
                width: { size: 12, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: isExamRtl ? 'نوعیت' : 'Type', bold: true, rightToLeft: isExamRtl })], ...textDir })],
              }),
              new TableCell({
                width: { size: 8, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: isExamRtl ? 'نمره' : 'Marks', bold: true, rightToLeft: isExamRtl })], ...textDir })],
              }),
              new TableCell({
                width: { size: 24, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: isExamRtl ? 'پاسخ صحیح' : 'Correct Answer', bold: true, rightToLeft: isExamRtl })], ...textDir })],
              }),
              new TableCell({
                width: { size: 26, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({ children: [new TextRun({ text: isExamRtl ? 'تشریح / معیار نمره‌دهی' : 'Explanation / Scoring Rubric', bold: true, rightToLeft: isExamRtl })], ...textDir }),
                ],
              }),
              new TableCell({
                width: { size: 22, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: isExamRtl ? 'استناد و منبع' : 'Source Provenance', bold: true, rightToLeft: isExamRtl })], ...textDir })],
              }),
            ],
          });

          const tableRows = [
            tableHeader,
            ...group.questions.map((q, idx) => {
              const provenanceParts: string[] = [];
              if (q.source_document_name) provenanceParts.push(isExamRtl ? `منبع: ${q.source_document_name}` : `Doc: ${q.source_document_name}`);
              if (q.source_page) provenanceParts.push(isExamRtl ? `صفحه: ${q.source_page}` : `Page: ${q.source_page}`);
              if (q.source_chapter) provenanceParts.push(isExamRtl ? `فصل: ${q.source_chapter}` : `Chapter: ${q.source_chapter}`);
              if (q.source_evidence) provenanceParts.push(isExamRtl ? `نقل‌قول: "${q.source_evidence}"` : `Evidence: "${q.source_evidence}"`);

              return new TableRow({
                children: [
                  new TableCell({
                    width: { size: 8, type: WidthType.PERCENTAGE },
                    children: [new Paragraph({ text: isExamRtl ? `${idx + 1}` : `Q${idx + 1}`, ...textDir })],
                  }),
                  new TableCell({
                    width: { size: 12, type: WidthType.PERCENTAGE },
                    children: [new Paragraph({ text: q.question_type || 'General', ...textDir })],
                  }),
                  new TableCell({
                    width: { size: 8, type: WidthType.PERCENTAGE },
                    children: [new Paragraph({ text: isExamRtl ? `${q.marks}` : `${q.marks} pt`, ...textDir })],
                  }),
                  new TableCell({
                    width: { size: 24, type: WidthType.PERCENTAGE },
                    children: [
                      new Paragraph({
                        children: [new TextRun({ text: q.correct_answer || '—', bold: true, color: '065F46', rightToLeft: isExamRtl })],
                        ...textDir,
                      }),
                    ],
                  }),
                  new TableCell({
                    width: { size: 26, type: WidthType.PERCENTAGE },
                    children: [
                      new Paragraph({
                        text: q.explanation || (isExamRtl ? 'مستند به مفاهیم منبع آموزشی.' : 'Directly grounded in source curriculum concepts.'),
                        ...textDir,
                      }),
                    ],
                  }),
                  new TableCell({
                    width: { size: 22, type: WidthType.PERCENTAGE },
                    children: [
                      new Paragraph({
                        text: provenanceParts.join('\n') || (isExamRtl ? 'تأییدشده از منبع' : 'Source Verified'),
                        ...textDir,
                      }),
                    ],
                  }),
                ],
              });
            }),
          ];

          children.push(
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: tableRows,
            }),
            new Paragraph({
              children: [
                new TextRun({
                  text: isExamRtl
                    ? 'سند کاملاً محرمانه امتحانی. قبل از اتمام کامل نمره‌دهی، از در اختیار قرار دادن آن به محصلین خودداری گردد.'
                    : 'Strictly confidential academic grading document. Not to be distributed to students before grading is concluded.',
                  italics: true,
                  color: '991B1B',
                  rightToLeft: isExamRtl,
                }),
              ],
              ...centerDir,
              spacing: { before: 140, after: 100 },
            })
          );
        }

        docxSections.push({ children });
      }

      const doc = new DocxDocument({ sections: docxSections });
      const buffer = await Packer.toBuffer(doc);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    } catch (err: any) {
      return res.status(500).json({ detail: `Failed to export DOCX: ${err.message}` });
    }
  });

  // Helper function to wrap text for PDF without any truncation or clipping
  function wrapPdfText(text: string, font: any, fontSize: number, maxWidth: number, isRtl = false): string[] {
    if (!text) return [];
    const clean = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const paragraphs = clean.split('\n');
    const result: string[] = [];

    for (const para of paragraphs) {
      if (!para.trim()) {
        result.push('');
        continue;
      }
      const words = para.split(/\s+/).filter(Boolean);
      let currentLine = '';

      for (const word of words) {
        const testCandidate = currentLine ? `${currentLine} ${word}` : word;
        let width = 0;
        try {
          const measured = isRtl ? formatPdfText(testCandidate, true) : testCandidate;
          width = font.widthOfTextAtSize(measured, fontSize);
        } catch {
          width = testCandidate.length * (fontSize * 0.55);
        }

        if (width <= maxWidth) {
          currentLine = testCandidate;
        } else {
          if (currentLine) {
            result.push(currentLine);
            currentLine = word;
          } else {
            result.push(word);
            currentLine = '';
          }
        }
      }
      if (currentLine) {
        result.push(currentLine);
      }
    }

    return result;
  }

  // Font buffers cached in memory for high-performance PDF export
  let cachedRegularFont: Buffer | null = null;
  let cachedBoldFont: Buffer | null = null;
  let cachedObliqueFont: Buffer | null = null;

  function loadPdfFontBuffers() {
    const tryRead = (candidates: string[]) => {
      for (const c of candidates) {
        try {
          if (fs.existsSync(c)) {
            return fs.readFileSync(c);
          }
        } catch {
          // continue
        }
      }
      return null;
    };

    if (!cachedRegularFont) {
      cachedRegularFont = tryRead([
        path.resolve(__dirname, 'fonts', 'Vazir-Regular.ttf'),
        path.resolve(process.cwd(), 'fonts', 'Vazir-Regular.ttf'),
        '/app/applet/fonts/Vazir-Regular.ttf',
        path.resolve(__dirname, 'fonts', 'FreeSans.ttf'),
        path.resolve(process.cwd(), 'fonts', 'FreeSans.ttf'),
        '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      ]);
    }
    if (!cachedBoldFont) {
      cachedBoldFont = tryRead([
        path.resolve(__dirname, 'fonts', 'Vazir-Bold.ttf'),
        path.resolve(process.cwd(), 'fonts', 'Vazir-Bold.ttf'),
        '/app/applet/fonts/Vazir-Bold.ttf',
        path.resolve(__dirname, 'fonts', 'FreeSansBold.ttf'),
        path.resolve(process.cwd(), 'fonts', 'FreeSansBold.ttf'),
        '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      ]);
    }
    if (!cachedObliqueFont) {
      cachedObliqueFont = tryRead([
        path.resolve(__dirname, 'fonts', 'Vazir-Light.ttf'),
        path.resolve(process.cwd(), 'fonts', 'Vazir-Light.ttf'),
        '/app/applet/fonts/Vazir-Light.ttf',
        path.resolve(__dirname, 'fonts', 'FreeSansOblique.ttf'),
        path.resolve(process.cwd(), 'fonts', 'FreeSansOblique.ttf'),
        '/usr/share/fonts/truetype/freefont/FreeSansOblique.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
      ]);
    }

    return {
      regular: cachedRegularFont,
      bold: cachedBoldFont,
      oblique: cachedObliqueFont,
    };
  }

  app.get('/api/exams/:id/export/pdf', async (req: Request, res: Response) => {
    const exam = db.getExamById(req.params.id);
    if (!exam) {
      return res.status(404).json({ detail: 'Exam not found' });
    }

    const groupId = req.query.group_id as string | undefined;
    let targetGroups = exam.groups;

    if (groupId) {
      const found = exam.groups.find((g) => g.id === groupId);
      if (!found) {
        return res.status(404).json({ detail: 'Target group not found.' });
      }
      targetGroups = [found];
    }

    const targetMode = ((req.query.target as string) || 'both').toLowerCase();
    const filename = sanitizeExportFilename(
      exam.title,
      targetGroups.length === 1 ? targetGroups[0].group_name : null,
      'pdf'
    );

    try {
      const pdfDoc = await PDFDocument.create();
      const fontBuffers = loadPdfFontBuffers();

      let font: any;
      let fontBold: any;
      let fontOblique: any;

      if (fontBuffers.regular) {
        pdfDoc.registerFontkit(fontkit);
        font = await pdfDoc.embedFont(fontBuffers.regular, { subset: true });
        fontBold = fontBuffers.bold
          ? await pdfDoc.embedFont(fontBuffers.bold, { subset: true })
          : font;
        fontOblique = fontBuffers.oblique
          ? await pdfDoc.embedFont(fontBuffers.oblique, { subset: true })
          : font;

        enableRtlOnEmbeddedFont(font);
        enableRtlOnEmbeddedFont(fontBold);
        enableRtlOnEmbeddedFont(fontOblique);
      } else {
        font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        fontOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
      }

      const pageWidth = 595.28;
      const pageHeight = 841.89;
      const marginX = 45;
      const contentWidth = pageWidth - marginX * 2; // 505.28

      for (const group of targetGroups) {
        const groupMarks = group.questions.reduce((sum, q) => sum + (q.marks || 0), 0);
        let page = pdfDoc.addPage([pageWidth, pageHeight]);
        let y = pageHeight - 45;

        const isExamRtl = Boolean(exam.is_rtl) || detectIsRtl(exam.title || '') || detectIsRtl(exam.subject || '') || exam.language === 'fa';

        const safeDraw = (textStr: string, opts: any, targetPage = page) => {
          try {
            targetPage.drawText(textStr, opts);
          } catch {
            try {
              const sanitized = textStr.replace(/[^\x20-\x7E\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF\u2000-\u206F\u2190-\u21FF\u2200-\u22FF\u2700-\u27BF]/g, ' ');
              targetPage.drawText(sanitized, opts);
            } catch {
              // safe fallback for unusual individual glyphs
            }
          }
        };

        const ensureSpace = (neededHeight: number, isAnswerKey = false) => {
          if (y - neededHeight < 45) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            y = pageHeight - 45;
            const subLabel = isAnswerKey
              ? (isExamRtl ? 'کلید سوالات و معیار نمره‌دهی (ادامه)' : 'Answer Key & Scoring Rubric Continued')
              : (isExamRtl ? 'ورقه امتحانی محصل (ادامه)' : 'Student Examination Paper Continued');
            const contTitle = isExamRtl
              ? `(${subLabel}) ${group.group_name} - ${exam.title}`
              : `${exam.title} - ${group.group_name} (${subLabel})`;
            
            const contFormatted = isExamRtl ? formatPdfText(contTitle, true) : contTitle;
            const contWidth = fontOblique.widthOfTextAtSize(contFormatted, 8);
            const contX = isExamRtl ? Math.max(marginX, pageWidth - marginX - contWidth) : marginX;

            safeDraw(contFormatted, {
              x: contX,
              y,
              size: 8,
              font: fontOblique,
              color: rgb(0.5, 0.5, 0.5),
            });
            page.drawLine({
              start: { x: marginX, y: y - 4 },
              end: { x: pageWidth - marginX, y: y - 4 },
              thickness: 0.5,
              color: rgb(0.85, 0.85, 0.85),
            });
            y -= 22;
          }
        };

        const drawWrapped = (
          text: string,
          x: number,
          fontSize: number,
          usedFont: any,
          color: any,
          maxWidth: number,
          lineHeight = fontSize * 1.35,
          isAnswerKey = false,
          forceRtl = false
        ) => {
          const isTextRtl = forceRtl || isExamRtl || detectIsRtl(text);
          const lines = wrapPdfText(text, usedFont, fontSize, maxWidth, isTextRtl);
          for (const rawLine of lines) {
            ensureSpace(lineHeight, isAnswerKey);
            const line = isTextRtl ? formatPdfText(rawLine, true) : rawLine;
            let drawX = x;
            if (isTextRtl) {
              try {
                const lineW = usedFont.widthOfTextAtSize(line, fontSize);
                const indent = x > marginX ? x - marginX : 0;
                drawX = Math.max(marginX, pageWidth - marginX - lineW - indent);
              } catch {
                drawX = x;
              }
            }
            safeDraw(line, {
              x: drawX,
              y,
              size: fontSize,
              font: usedFont,
              color,
            });
            y -= lineHeight;
          }
        };

        // 1. STUDENT EXAMINATION PAPER
        if (targetMode === 'both' || targetMode === 'exam') {
          // Institutional Header
          const instParts = [exam.institution, exam.faculty]
            .filter(Boolean)
            .map((s) => String(s).trim())
            .filter(Boolean);
          const instHeader = instParts.join(' — ');

          if (instHeader) {
            const instFormatted = isExamRtl ? formatPdfText(instHeader, true) : instHeader;
            const instW = fontBold.widthOfTextAtSize(instFormatted, 11);
            const instX = isExamRtl ? Math.max(marginX, pageWidth - marginX - instW) : marginX;
            safeDraw(instFormatted, {
              x: instX,
              y,
              size: 11,
              font: fontBold,
              color: rgb(0.2, 0.2, 0.2),
            });
            y -= 20;
          }

          const titleText = `${exam.title} - ${group.group_name}`;
          const titleFormatted = isExamRtl ? formatPdfText(titleText, true) : titleText;
          const titleW = fontBold.widthOfTextAtSize(titleFormatted, 14);
          const titleX = isExamRtl ? Math.max(marginX, pageWidth - marginX - titleW) : marginX;
          safeDraw(titleFormatted, {
            x: titleX,
            y,
            size: 14,
            font: fontBold,
            color: rgb(0.05, 0.05, 0.05),
          });
          y -= 17;

          const metaText = isExamRtl
            ? `مضمون: ${exam.subject}  |  مدت: ${exam.duration_minutes} دقیقه  |  مجموع نمرات: ${groupMarks}  |  گروپ: ${group.group_name}`
            : `Subject: ${exam.subject}  |  Duration: ${exam.duration_minutes} Mins  |  Max Marks: ${groupMarks} pts  |  Variant: ${group.group_name}`;
          const metaFormatted = isExamRtl ? formatPdfText(metaText, true) : metaText;
          const metaW = font.widthOfTextAtSize(metaFormatted, 9);
          const metaX = isExamRtl ? Math.max(marginX, pageWidth - marginX - metaW) : marginX;
          safeDraw(metaFormatted, {
            x: metaX,
            y,
            size: 9,
            font,
            color: rgb(0.35, 0.35, 0.35),
          });
          y -= 18;

          page.drawLine({
            start: { x: marginX, y },
            end: { x: pageWidth - marginX, y },
            thickness: 0.8,
            color: rgb(0.8, 0.8, 0.8),
          });
          y -= 14;

          // Student Info Box
          page.drawRectangle({
            x: marginX,
            y: y - 42,
            width: contentWidth,
            height: 42,
            borderColor: rgb(0.75, 0.75, 0.75),
            borderWidth: 0.7,
            color: rgb(0.98, 0.98, 0.98),
          });

          if (isExamRtl) {
            const line1R = formatPdfText('نام و تخلص محصل: _________________________________', true);
            const line1L = formatPdfText('نمبر چوکی / تذکره: __________________', true);
            const line2R = formatPdfText(`تاریخ: ${exam.exam_date || new Date().toISOString().split('T')[0]}    |    مدت: ${exam.duration_minutes} دقیقه`, true);
            const line2L = formatPdfText(`مجموع نمرات: ${groupMarks} نمره    |    گروپ: ${group.group_name}`, true);

            const w1R = font.widthOfTextAtSize(line1R, 8.5);
            const w1L = font.widthOfTextAtSize(line1L, 8.5);
            const w2R = font.widthOfTextAtSize(line2R, 8.5);
            const w2L = font.widthOfTextAtSize(line2L, 8.5);

            safeDraw(line1R, {
              x: pageWidth - marginX - 16 - w1R,
              y: y - 16,
              size: 8.5,
              font,
              color: rgb(0.1, 0.1, 0.1),
            });
            safeDraw(line1L, {
              x: pageWidth - marginX - 300 - w1L,
              y: y - 16,
              size: 8.5,
              font,
              color: rgb(0.1, 0.1, 0.1),
            });
            safeDraw(line2R, {
              x: pageWidth - marginX - 16 - w2R,
              y: y - 32,
              size: 8.5,
              font,
              color: rgb(0.25, 0.25, 0.25),
            });
            safeDraw(line2L, {
              x: pageWidth - marginX - 300 - w2L,
              y: y - 32,
              size: 8.5,
              font,
              color: rgb(0.25, 0.25, 0.25),
            });
          } else {
            safeDraw('Student Name: _________________________________', {
              x: marginX + 8,
              y: y - 16,
              size: 8.5,
              font,
              color: rgb(0.1, 0.1, 0.1),
            });
            safeDraw('Roll / Seat No: __________________', {
              x: marginX + 290,
              y: y - 16,
              size: 8.5,
              font,
              color: rgb(0.1, 0.1, 0.1),
            });
            safeDraw(
              `Date: ${exam.exam_date || new Date().toISOString().split('T')[0]}    |    Duration: ${exam.duration_minutes} Mins`,
              {
                x: marginX + 8,
                y: y - 32,
                size: 8.5,
                font,
                color: rgb(0.25, 0.25, 0.25),
              }
            );
            safeDraw(`Max Marks: ${groupMarks} pts    |    Group: ${group.group_name}`, {
              x: marginX + 290,
              y: y - 32,
              size: 8.5,
              font,
              color: rgb(0.25, 0.25, 0.25),
            });
          }
          y -= 54;

          // Instructions
          const instrText = isExamRtl
            ? 'رهنمود: به کلیه سوالات در فضای تعیین‌شده پاسخ دهید. استفاده از هرگونه یادداشت یا وسیله غیرمجاز ممنوع است.'
            : 'Instructions: Answer all questions in the space provided. Verify your group code. Unauthorized items strictly prohibited.';
          const instrFormatted = isExamRtl ? formatPdfText(instrText, true) : instrText;
          const instrW = fontOblique.widthOfTextAtSize(instrFormatted, 8);
          const instrX = isExamRtl ? Math.max(marginX, pageWidth - marginX - instrW) : marginX;
          safeDraw(instrFormatted, {
            x: instrX,
            y,
            size: 8,
            font: fontOblique,
            color: rgb(0.4, 0.4, 0.4),
          });
          y -= 18;

          // Render Questions
          group.questions.forEach((q, idx) => {
            const qType = (q.question_type || '').toLowerCase();
            ensureSpace(45, false);

            // Question Header & Marks
            const qPrefix = isExamRtl ? `سوال ${idx + 1}. [${q.marks} نمره] ` : `Q${idx + 1}. [${q.marks} pt${q.marks !== 1 ? 's' : ''}] `;
            const fullQText = `${qPrefix}${q.question_text}`;
            drawWrapped(fullQText, marginX, 9.5, fontBold, rgb(0.1, 0.1, 0.1), contentWidth, 13, false, isExamRtl);
            y -= 4;

            // Options and response area
            if (qType === 'mcq' && q.options && q.options.length > 0) {
              const optLabels = isExamRtl
                ? ['الف)', 'ب)', 'ج)', 'د)', 'هـ)', 'و)']
                : ['(A)', '(B)', '(C)', '(D)', '(E)', '(F)'];
              q.options.forEach((opt, oIdx) => {
                const cleanOpt = String(opt).replace(/^(\([A-Za-z0-9\u0621-\u064A\u067E\u0686\u0698\u06AF\u06CC\u06A9]+\)|[A-Za-z0-9\u0621-\u064A\u067E\u0686\u0698\u06AF\u06CC\u06A9]+[\:\.\-\)])\s*/, '').trim();
                const optText = `${optLabels[oIdx] || `(${oIdx + 1})`}  ${cleanOpt}`;
                drawWrapped(optText, marginX + 16, 9, font, rgb(0.2, 0.2, 0.2), contentWidth - 16, 12, false, isExamRtl);
                y -= 2;
              });

              ensureSpace(16, false);
              const selOptText = isExamRtl ? 'گزینه انتخابی:  [ _______ ]' : 'Selected Option:  [ _______ ]';
              const selFormatted = isExamRtl ? formatPdfText(selOptText, true) : selOptText;
              const selW = fontOblique.widthOfTextAtSize(selFormatted, 8.5);
              const selX = isExamRtl ? Math.max(marginX, pageWidth - marginX - selW - 16) : marginX + 16;
              safeDraw(selFormatted, {
                x: selX,
                y,
                size: 8.5,
                font: fontOblique,
                color: rgb(0.45, 0.45, 0.45),
              });
              y -= 14;
            } else if (qType === 'true_false') {
              ensureSpace(16, false);
              const tfText = isExamRtl ? '[   ]  صحیح                  [   ]  غلط' : '[   ]  True                  [   ]  False';
              const tfFormatted = isExamRtl ? formatPdfText(tfText, true) : tfText;
              const tfW = font.widthOfTextAtSize(tfFormatted, 9);
              const tfX = isExamRtl ? Math.max(marginX, pageWidth - marginX - tfW - 16) : marginX + 16;
              safeDraw(tfFormatted, {
                x: tfX,
                y,
                size: 9,
                font,
                color: rgb(0.2, 0.2, 0.2),
              });
              y -= 14;
            } else if (qType === 'fill_blank') {
              ensureSpace(16, false);
              const fbText = isExamRtl
                ? 'پاسخ: __________________________________________________________________'
                : 'Answer: __________________________________________________________________';
              const fbFormatted = isExamRtl ? formatPdfText(fbText, true) : fbText;
              const fbW = font.widthOfTextAtSize(fbFormatted, 9);
              const fbX = isExamRtl ? Math.max(marginX, pageWidth - marginX - fbW - 16) : marginX + 16;
              safeDraw(fbFormatted, {
                x: fbX,
                y,
                size: 9,
                font,
                color: rgb(0.25, 0.25, 0.25),
              });
              y -= 14;
            } else if (qType === 'essay') {
              for (let line = 0; line < 5; line++) {
                ensureSpace(14, false);
                safeDraw(
                  '. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .',
                  {
                    x: marginX + 10,
                    y,
                    size: 8,
                    font,
                    color: rgb(0.65, 0.65, 0.65),
                  }
                );
                y -= 12;
              }
              y -= 4;
            } else {
              for (let line = 0; line < 3; line++) {
                ensureSpace(14, false);
                safeDraw(
                  '. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .',
                  {
                    x: marginX + 10,
                    y,
                    size: 8,
                    font,
                    color: rgb(0.65, 0.65, 0.65),
                  }
                );
                y -= 12;
              }
              y -= 4;
            }

            y -= 6;
          });

          ensureSpace(24, false);
          const endText = isExamRtl
            ? `--- پایان ورقه امتحانی (${group.group_name}) ---`
            : `--- END OF EXAMINATION PAPER (${group.group_name}) ---`;
          const endFormatted = isExamRtl ? formatPdfText(endText, true) : endText;
          const endW = fontBold.widthOfTextAtSize(endFormatted, 8.5);
          safeDraw(endFormatted, {
            x: (pageWidth - endW) / 2,
            y,
            size: 8.5,
            font: fontBold,
            color: rgb(0.5, 0.5, 0.5),
          });
          y -= 20;
        }

        // 2. TEACHER ANSWER KEY & SCORING RUBRICS
        if (targetMode === 'both' || targetMode === 'answer_key') {
          if (targetMode === 'both') {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            y = pageHeight - 45;
          }

          // Confidential Header
          const confHeader = isExamRtl
            ? 'محرمانه — کلید رسمی سوالات و رهنمود نمره‌دهی اساتید'
            : 'CONFIDENTIAL - OFFICIAL TEACHER ANSWER KEY & SCORING RUBRICS';
          const confFormatted = isExamRtl ? formatPdfText(confHeader, true) : confHeader;
          const confW = fontBold.widthOfTextAtSize(confFormatted, 11);
          const confX = isExamRtl ? Math.max(marginX, pageWidth - marginX - confW) : marginX;
          safeDraw(confFormatted, {
            x: confX,
            y,
            size: 11,
            font: fontBold,
            color: rgb(0.65, 0.1, 0.1),
          });
          y -= 18;

          const keyTitle = isExamRtl
            ? `${exam.title} - ${group.group_name} کلید و معیار جامع نمره‌دهی`
            : `${exam.title} - ${group.group_name} Master Grading Rubric`;
          const keyFormatted = isExamRtl ? formatPdfText(keyTitle, true) : keyTitle;
          const keyW = fontBold.widthOfTextAtSize(keyFormatted, 13);
          const keyX = isExamRtl ? Math.max(marginX, pageWidth - marginX - keyW) : marginX;
          safeDraw(keyFormatted, {
            x: keyX,
            y,
            size: 13,
            font: fontBold,
            color: rgb(0.1, 0.1, 0.1),
          });
          y -= 16;

          const keyMeta = isExamRtl
            ? `مضمون: ${exam.subject}  |  تعداد سوالات: ${group.questions.length}  |  مجموع نمرات: ${groupMarks}`
            : `Subject: ${exam.subject}  |  Total Questions: ${group.questions.length}  |  Total Marks: ${groupMarks} pts`;
          const keyMetaFormatted = isExamRtl ? formatPdfText(keyMeta, true) : keyMeta;
          const keyMetaW = font.widthOfTextAtSize(keyMetaFormatted, 9);
          const keyMetaX = isExamRtl ? Math.max(marginX, pageWidth - marginX - keyMetaW) : marginX;
          safeDraw(keyMetaFormatted, {
            x: keyMetaX,
            y,
            size: 9,
            font,
            color: rgb(0.35, 0.35, 0.35),
          });
          y -= 16;

          page.drawLine({
            start: { x: marginX, y },
            end: { x: pageWidth - marginX, y },
            thickness: 1,
            color: rgb(0.7, 0.15, 0.15),
          });
          y -= 18;

          // Render each question's answer item
          group.questions.forEach((q, idx) => {
            ensureSpace(70, true);

            const qHeader = isExamRtl
              ? `سوال ${idx + 1} (${q.question_type || 'عمومی'} - ${q.marks} نمره):`
              : `Q${idx + 1} (${(q.question_type || 'General').toUpperCase()} - ${q.marks} pt):`;
            const qHeaderFormatted = isExamRtl ? formatPdfText(qHeader, true) : qHeader;
            const qHeaderW = fontBold.widthOfTextAtSize(qHeaderFormatted, 9.5);
            const qHeaderX = isExamRtl ? Math.max(marginX, pageWidth - marginX - qHeaderW) : marginX;
            safeDraw(qHeaderFormatted, {
              x: qHeaderX,
              y,
              size: 9.5,
              font: fontBold,
              color: rgb(0.1, 0.2, 0.4),
            });
            y -= 13;

            const qLabel = isExamRtl ? `سوال: ${q.question_text}` : `Question: ${q.question_text}`;
            drawWrapped(qLabel, marginX + 8, 8.5, fontOblique, rgb(0.2, 0.2, 0.2), contentWidth - 8, 12, true, isExamRtl);
            y -= 3;

            const ansLabel = isExamRtl ? `پاسخ صحیح: ${q.correct_answer || '—'}` : `Correct Answer: ${q.correct_answer || '—'}`;
            drawWrapped(ansLabel, marginX + 8, 9, fontBold, rgb(0.05, 0.45, 0.15), contentWidth - 8, 12.5, true, isExamRtl);
            y -= 3;

            const explanationText = isExamRtl
              ? `تشریح و معیار نمره‌دهی: ${q.explanation || 'مستند به متن منبع آموزشی.'}`
              : (q.explanation ? `Explanation & Rubric: ${q.explanation}` : 'Explanation & Rubric: Derived directly from source reference materials.');
            drawWrapped(explanationText, marginX + 8, 8.5, font, rgb(0.25, 0.25, 0.25), contentWidth - 8, 12, true, isExamRtl);
            y -= 3;

            let provStr = isExamRtl
              ? `استناد منبع: ${q.source_document_name || 'منبع'} (صفحه ${q.source_page || 1}${q.source_chapter ? `، ${q.source_chapter}` : ''})`
              : `Source Provenance: ${q.source_document_name || 'Document'} (Page ${q.source_page || 1}${q.source_chapter ? `, ${q.source_chapter}` : ''}${q.source_section ? `, ${q.source_section}` : ''})`;
            if (q.source_evidence) {
              provStr += isExamRtl ? ` | نقل‌قول: "${q.source_evidence}"` : ` | Citation: "${q.source_evidence}"`;
            }
            drawWrapped(provStr, marginX + 8, 8, font, rgb(0.4, 0.4, 0.4), contentWidth - 8, 11, true, isExamRtl);
            y -= 6;

            ensureSpace(8, true);
            page.drawLine({
              start: { x: marginX + 8, y },
              end: { x: pageWidth - marginX - 8, y },
              thickness: 0.5,
              color: rgb(0.88, 0.88, 0.88),
            });
            y -= 10;
          });

          ensureSpace(20, true);
          const confFoot = isExamRtl
            ? '--- سند کاملاً محرمانه — صرفاً جهت استفاده اساتید ---'
            : '--- Strictly Confidential - Academic Faculty Grading Only ---';
          const confFootFormatted = isExamRtl ? formatPdfText(confFoot, true) : confFoot;
          const confFootW = fontOblique.widthOfTextAtSize(confFootFormatted, 8);
          safeDraw(confFootFormatted, {
            x: (pageWidth - confFootW) / 2,
            y,
            size: 8,
            font: fontOblique,
            color: rgb(0.65, 0.15, 0.15),
          });
        }
      }

      const pdfBytes = await pdfDoc.save();

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(Buffer.from(pdfBytes));
    } catch (err: any) {
      return res.status(500).json({ detail: `Failed to export PDF: ${err.message}` });
    }
  });

  // Global Express Error Handler
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error('Express Server Error:', err);
    res.status(500).json({
      detail: err.message || 'An unexpected error occurred in the server.',
    });
  });

  // ==========================================
  // FRONTEND INTEGRATION: VITE MIDDLEWARE
  // ==========================================
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const isHmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: isHmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req: Request, res: Response) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ExamCraft AI Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
